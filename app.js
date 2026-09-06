(function(){
  "use strict";

  // ---------- Constants ----------
  const FRAME_ASPECT = 3 / 4; // .thumb / .detail-thumb / .thumb-preview / .crop-frame は全て3:4で統一
  const THUMB_MAX_DIM = 1600;
  const SCALE_MIN = 0.2, SCALE_MAX = 3;
  const PROMPT_CHAR_LIMIT = 4096; // PixAI等、改行も1文字としてカウントする仕様に合わせた上限

  // ---------- 画像フィット計算（G:\Claude\image-fit-handoff より移植） ----------
  // object-fit:contain を土台に、cover と同じ見た目になる倍率(coverFactor)を掛けることで、
  // scale=1で従来のcoverと同じ見た目、scale<1で縮小しつつ切れていた部分が戻ってくる。
  function getCoverFactor(frameAspect, imageAspect){
    if (!frameAspect || !imageAspect || !Number.isFinite(frameAspect) || !Number.isFinite(imageAspect)) return 1;
    return Math.max(frameAspect / imageAspect, imageAspect / frameAspect);
  }
  function buildImageStyle({ transform, frameAspect, imageAspect }){
    const { scale = 1, x = 0, y = 0 } = transform || {};
    if (!imageAspect){
      return { objectFit: "cover", transform: `translate(${x}%, ${y}%) scale(${scale})` };
    }
    const factor = getCoverFactor(frameAspect, imageAspect);
    return { objectFit: "contain", transform: `translate(${x}%, ${y}%) scale(${scale * factor})` };
  }
  function applyThumbStyle(imgEl, transform, imageAspect){
    if (!imgEl) return;
    const style = buildImageStyle({ transform, frameAspect: FRAME_ASPECT, imageAspect });
    imgEl.style.objectFit = style.objectFit;
    imgEl.style.transform = style.transform;
  }
  function clamp(value, min, max){ return Math.min(max, Math.max(min, value)); }

  // 括弧内のカンマを無視してトップレベルのカンマだけで分割する（重み表記 (masterpiece:1.2) 等が壊れない）
  function splitTopLevel(str){
    const result = [];
    let depth = 0, current = "";
    for (const ch of str){
      if ("([{".includes(ch)) depth++;
      if (")]}".includes(ch)) depth = Math.max(0, depth - 1);
      if (ch === "," && depth === 0){ result.push(current.trim()); current = ""; }
      else current += ch;
    }
    if (current.trim()) result.push(current.trim());
    return result.filter(Boolean);
  }

  // ---------- IndexedDB helpers ----------
  const DB_NAME = "character_library_db";
  const STORE = "entries";
  let dbPromise = null;

  function openDB(){
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)){
          const store = db.createObjectStore(STORE, { keyPath: "id" });
          store.createIndex("createdAt", "createdAt");
        }
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    });
    return dbPromise;
  }
  async function dbGetAll(){
    try{
      const db = await openDB();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readonly");
        const req = tx.objectStore(STORE).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    }catch(err){ console.error("dbGetAll failed", err); return []; }
  }
  async function dbPut(entry){
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async function dbDelete(id){
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ---------- State ----------
  let entries = [];
  let activeTags = new Set();
  let searchQuery = "";
  let sortMode = "date-desc";
  let editingId = null;
  let currentTags = [];
  let currentThumb = null;
  let currentThumbTransform = { scale: 1, x: 0, y: 0 };
  let currentThumbAspect = null;
  let currentLoras = [];
  let detailEntryId = null;
  let currentView = "list";
  let dictActiveCategory = null;
  let dictQuery = "";
  let formDictCategory = null;
  let formDictQuery = "";
  let formDictTarget = "prompt";

  // ---------- Elements ----------
  const listView = document.getElementById("listView");
  const listHeaderActions = document.getElementById("listHeaderActions");
  const cheatsheetView = document.getElementById("cheatsheetView");
  const cheatsheetNavBtn = document.getElementById("cheatsheetNavBtn");

  const grid = document.getElementById("grid");
  const emptyState = document.getElementById("emptyState");
  const emptyText = document.getElementById("emptyText");
  const countPill = document.getElementById("countPill");
  const tagFilterRow = document.getElementById("tagFilterRow");
  const searchInput = document.getElementById("searchInput");
  const sortSelect = document.getElementById("sortSelect");

  const formOverlay = document.getElementById("formOverlay");
  const formTitle = document.getElementById("formTitle");
  const nameInput = document.getElementById("nameInput");
  const promptInput = document.getElementById("promptInput");
  const negativeInput = document.getElementById("negativeInput");
  const notesInput = document.getElementById("notesInput");
  const modelInput = document.getElementById("modelInput");
  const samplerInput = document.getElementById("samplerInput");
  const stepsInput = document.getElementById("stepsInput");
  const cfgInput = document.getElementById("cfgInput");
  const shiftInput = document.getElementById("shiftInput");
  const promptCharCounter = document.getElementById("promptCharCounter");
  const parentSelect = document.getElementById("parentSelect");

  const tagEditor = document.getElementById("tagEditor");
  const tagInput = document.getElementById("tagInput");
  const thumbPreview = document.getElementById("thumbPreview");
  const imageInput = document.getElementById("imageInput");
  const removeImageBtn = document.getElementById("removeImageBtn");
  const adjustImageBtn = document.getElementById("adjustImageBtn");
  const loraList = document.getElementById("loraList");

  const formDictSearch = document.getElementById("formDictSearch");
  const formDictCategoryRow = document.getElementById("formDictCategoryRow");
  const formDictResults = document.getElementById("formDictResults");

  const dictSearchInput = document.getElementById("dictSearchInput");
  const dictCategoryRow = document.getElementById("dictCategoryRow");
  const dictResultsGrid = document.getElementById("dictResultsGrid");
  const dictEmptyState = document.getElementById("dictEmptyState");

  const cropBackdrop = document.getElementById("cropBackdrop");
  const cropFrame = document.getElementById("cropFrame");
  const cropImg = document.getElementById("cropImg");
  const cropScaleRange = document.getElementById("cropScaleRange");
  const cropScaleValue = document.getElementById("cropScaleValue");

  const detailOverlay = document.getElementById("detailOverlay");
  const detailThumb = document.getElementById("detailThumb");
  const detailName = document.getElementById("detailName");
  const detailTags = document.getElementById("detailTags");
  const detailDate = document.getElementById("detailDate");
  const detailPromptText = document.getElementById("detailPromptText");
  const detailPromptGroups = document.getElementById("detailPromptGroups");
  const detailNegative = document.getElementById("detailNegative");
  const detailRelationsSection = document.getElementById("detailRelationsSection");
  const detailRelations = document.getElementById("detailRelations");
  const detailSettingsGrid = document.getElementById("detailSettingsGrid");
  const detailNotesSection = document.getElementById("detailNotesSection");
  const detailNotes = document.getElementById("detailNotes");

  const confirmOverlay = document.getElementById("confirmOverlay");
  const toast = document.getElementById("toast");

  // ---------- Utilities ----------
  function uid(){ return "e_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2,8); }
  function showToast(msg){
    toast.textContent = msg;
    toast.classList.add("show");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.remove("show"), 2000);
  }
  function escapeHtml(str){
    return (str || "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
  }
  function formatDate(ts){
    const d = new Date(ts);
    return d.getFullYear() + "年" + (d.getMonth()+1) + "月" + d.getDate() + "日 " +
      String(d.getHours()).padStart(2,"0") + ":" + String(d.getMinutes()).padStart(2,"0");
  }
  function updatePromptCharCounter(){
    const len = promptInput.value.length; // 改行も1文字としてカウントされる（textareaのvalueは常にLF区切り）
    promptCharCounter.textContent = `${len} / ${PROMPT_CHAR_LIMIT}`;
    promptCharCounter.classList.toggle("over-limit", len > PROMPT_CHAR_LIMIT);
  }
  promptInput.addEventListener("input", updatePromptCharCounter);

  async function copyText(text){
    if (!text){ showToast("コピーする内容がありません"); return; }
    try{ await navigator.clipboard.writeText(text); showToast("コピーしました"); }
    catch(err){ showToast("コピーに失敗しました"); }
  }
  // 画像を長辺 THUMB_MAX_DIM にリサイズしてJPEG(base64)化し、あわせて画像自体の縦横比を返す
  function resizeImage(file, maxDim){
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          try{
            let { width, height } = img;
            const aspect = width / height;
            if (width > height && width > maxDim){ height = Math.round(height * (maxDim / width)); width = maxDim; }
            else if (height >= width && height > maxDim){ width = Math.round(width * (maxDim / height)); height = maxDim; }
            const canvas = document.createElement("canvas");
            canvas.width = width; canvas.height = height;
            const ctx = canvas.getContext("2d");
            if (!ctx) throw new Error("画像を処理するためのCanvasを作成できませんでした");
            ctx.drawImage(img, 0, 0, width, height);
            resolve({ dataUrl: canvas.toDataURL("image/jpeg", 0.85), aspect });
          }catch(err){ reject(err); }
        };
        img.onerror = () => reject(new Error("画像の読み込みに失敗しました"));
        img.src = e.target.result;
      };
      reader.onerror = () => reject(new Error("ファイルの読み込みに失敗しました"));
      reader.readAsDataURL(file);
    });
  }

  // ---------- Character tag editor (chip-editor reusable pattern) ----------
  function renderTagEditor(){
    tagEditor.querySelectorAll(".chip-editor-chip").forEach(el => el.remove());
    currentTags.forEach((tag, idx) => {
      const chip = document.createElement("span");
      chip.className = "chip-editor-chip";
      chip.innerHTML = `${escapeHtml(tag)} <button type="button">✕</button>`;
      chip.querySelector("button").addEventListener("click", () => { currentTags.splice(idx,1); renderTagEditor(); });
      tagEditor.insertBefore(chip, tagInput);
    });
  }
  function addTagFromInput(){
    const raw = tagInput.value.trim().replace(/,$/, "");
    if (raw && !currentTags.includes(raw)){ currentTags.push(raw); renderTagEditor(); }
    tagInput.value = "";
  }
  tagInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === ","){ e.preventDefault(); addTagFromInput(); }
    else if (e.key === "Backspace" && tagInput.value === "" && currentTags.length){ currentTags.pop(); renderTagEditor(); }
  });
  tagInput.addEventListener("blur", () => { if (tagInput.value.trim()) addTagFromInput(); });

  // ---------- LoRA rows ----------
  function renderLoraList(){
    loraList.innerHTML = "";
    currentLoras.forEach((lora, idx) => {
      const row = document.createElement("div");
      row.className = "lora-row";
      row.innerHTML = `
        <input type="text" placeholder="LoRA名" value="${escapeHtml(lora.name)}">
        <input type="text" class="strength" placeholder="強さ" value="${escapeHtml(lora.strength)}">
        <button type="button" class="remove-row">✕</button>
      `;
      const [nameEl, strengthEl] = row.querySelectorAll("input");
      nameEl.addEventListener("input", () => { lora.name = nameEl.value; });
      strengthEl.addEventListener("input", () => { lora.strength = strengthEl.value; });
      row.querySelector(".remove-row").addEventListener("click", () => {
        currentLoras.splice(idx, 1);
        renderLoraList();
      });
      loraList.appendChild(row);
    });
  }
  document.getElementById("addLoraBtn").addEventListener("click", () => {
    currentLoras.push({ name: "", strength: "" });
    renderLoraList();
  });

  // ---------- プロンプト辞典 ----------
  const DICTIONARY_LOOKUP = new Map(PROMPT_DICTIONARY.map(item => [item.code.toLowerCase(), item]));
  const UNCLASSIFIED_LABEL = "未分類";

  // プロンプト文字列をトップレベルのカンマで分割し、辞典と照合してカテゴリ別にグループ化する
  // （入力側はプレーンテキストのままだが、詳細画面では辞典を使って自動的に内訳表示する）
  function categorizePromptText(promptText){
    const parts = splitTopLevel(promptText || "");
    const groups = {};
    parts.forEach(text => {
      const match = DICTIONARY_LOOKUP.get(text.toLowerCase());
      const cat = match ? match.category : UNCLASSIFIED_LABEL;
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(text);
    });
    const order = [...PROMPT_DICTIONARY_CATEGORIES, UNCLASSIFIED_LABEL];
    return order.filter(cat => groups[cat] && groups[cat].length).map(cat => ({ category: cat, tags: groups[cat] }));
  }

  function filterDictionary(category, query){
    const q = (query || "").trim().toLowerCase();
    return PROMPT_DICTIONARY.filter(item => {
      const matchesCategory = !category || item.category === category;
      const matchesQuery = !q || item.ja.toLowerCase().includes(q) || item.code.toLowerCase().includes(q);
      return matchesCategory && matchesQuery;
    });
  }
  function renderCategoryChips(container, activeCategory, onSelect){
    container.innerHTML = "";
    const allChip = document.createElement("button");
    allChip.type = "button";
    allChip.className = "tag-chip" + (!activeCategory ? " active" : "");
    allChip.textContent = "すべて";
    allChip.addEventListener("click", () => onSelect(null));
    container.appendChild(allChip);
    PROMPT_DICTIONARY_CATEGORIES.forEach(cat => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "tag-chip" + (activeCategory === cat ? " active" : "");
      chip.textContent = cat;
      chip.addEventListener("click", () => onSelect(cat));
      container.appendChild(chip);
    });
  }

  // フォーム内ピッカー：カテゴリ/検索のどちらかが指定されるまでは結果を出さない
  function renderFormDictPicker(){
    renderCategoryChips(formDictCategoryRow, formDictCategory, (cat) => { formDictCategory = cat; renderFormDictPicker(); });
    formDictResults.innerHTML = "";
    if (!formDictCategory && !formDictQuery.trim()){
      formDictResults.innerHTML = `<div class="dict-empty-hint">カテゴリを選ぶか、日本語で検索してください</div>`;
      return;
    }
    const results = filterDictionary(formDictCategory, formDictQuery);
    if (!results.length){
      formDictResults.innerHTML = `<div class="dict-empty-hint">該当するタグが見つかりませんでした</div>`;
      return;
    }
    results.forEach(item => {
      const row = document.createElement("div");
      row.className = "dict-item";
      row.innerHTML = `<div class="dict-item-text"><span class="dict-item-ja">${escapeHtml(item.ja)}</span><span class="dict-item-code">${escapeHtml(item.code)}</span></div><button type="button" class="btn btn-sm">追加</button>`;
      row.querySelector("button").addEventListener("click", () => addDictCodeToTarget(item.code));
      formDictResults.appendChild(row);
    });
  }
  function addDictCodeToTarget(code){
    const targetInput = formDictTarget === "negative" ? negativeInput : promptInput;
    const current = targetInput.value.trim();
    targetInput.value = current ? current + ", " + code : code;
    updatePromptCharCounter();
    showToast(`「${code}」を追加しました`);
  }
  formDictSearch.addEventListener("input", () => { formDictQuery = formDictSearch.value; renderFormDictPicker(); });
  document.querySelectorAll('input[name="dictTarget"]').forEach(radio => {
    radio.addEventListener("change", (e) => { formDictTarget = e.target.value; });
  });

  // チートシートページ
  function renderCheatsheet(){
    renderCategoryChips(dictCategoryRow, dictActiveCategory, (cat) => { dictActiveCategory = cat; renderCheatsheet(); });
    const results = filterDictionary(dictActiveCategory, dictQuery);
    dictResultsGrid.innerHTML = "";
    dictEmptyState.style.display = results.length ? "none" : "flex";
    results.forEach(item => {
      const card = document.createElement("div");
      card.className = "dict-card";
      card.innerHTML = `<div class="dict-card-ja">${escapeHtml(item.ja)}</div><div class="dict-card-code">${escapeHtml(item.code)}</div><button type="button" class="copy-btn">コピー</button>`;
      card.querySelector(".copy-btn").addEventListener("click", () => copyText(item.code));
      dictResultsGrid.appendChild(card);
    });
  }
  dictSearchInput.addEventListener("input", () => { dictQuery = dictSearchInput.value; renderCheatsheet(); });

  // ---------- ビュー切り替え（一覧 / プロンプト辞典） ----------
  function setView(view){
    currentView = view;
    listView.hidden = view !== "list";
    listHeaderActions.hidden = view !== "list";
    cheatsheetView.hidden = view !== "cheatsheet";
    cheatsheetNavBtn.textContent = view === "list" ? "📖 プロンプト辞典" : "🗂️ 一覧に戻る";
    if (view === "cheatsheet") renderCheatsheet();
  }
  cheatsheetNavBtn.addEventListener("click", () => setView(currentView === "list" ? "cheatsheet" : "list"));

  // ---------- 画像クロップ（位置・拡大調整）モーダル ----------
  let cropDragState = null;

  function updateCropPreview(){
    applyThumbStyle(cropImg, currentThumbTransform, currentThumbAspect);
    applyThumbStyle(thumbPreview.querySelector("img"), currentThumbTransform, currentThumbAspect);
    cropScaleRange.value = currentThumbTransform.scale;
    cropScaleValue.textContent = Math.round(currentThumbTransform.scale * 100) + "%";
  }
  function openCropModal(){
    if (!currentThumb) return;
    cropImg.src = currentThumb;
    updateCropPreview();
    cropBackdrop.classList.add("open");
  }
  function closeCropModal(){ cropBackdrop.classList.remove("open"); }

  cropFrame.addEventListener("pointerdown", (e) => {
    if (!currentThumb) return;
    cropFrame.setPointerCapture(e.pointerId);
    cropDragState = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startTransform: { ...currentThumbTransform },
      boxWidth: cropFrame.clientWidth || 1,
      boxHeight: cropFrame.clientHeight || 1,
    };
  });
  cropFrame.addEventListener("pointermove", (e) => {
    if (!cropDragState) return;
    const dxPercent = ((e.clientX - cropDragState.startX) / cropDragState.boxWidth) * 100;
    const dyPercent = ((e.clientY - cropDragState.startY) / cropDragState.boxHeight) * 100;
    currentThumbTransform.x = clamp(cropDragState.startTransform.x + dxPercent, -50, 50);
    currentThumbTransform.y = clamp(cropDragState.startTransform.y + dyPercent, -50, 50);
    updateCropPreview();
  });
  function endCropDrag(e){
    if (!cropDragState) return;
    cropFrame.releasePointerCapture(cropDragState.pointerId);
    cropDragState = null;
  }
  cropFrame.addEventListener("pointerup", endCropDrag);
  cropFrame.addEventListener("pointercancel", endCropDrag);

  cropScaleRange.addEventListener("input", () => {
    currentThumbTransform.scale = parseFloat(cropScaleRange.value);
    updateCropPreview();
  });
  document.getElementById("cropResetBtn").addEventListener("click", () => {
    currentThumbTransform = { scale: 1, x: 0, y: 0 };
    updateCropPreview();
  });
  document.getElementById("cropCloseBtn").addEventListener("click", closeCropModal);
  document.getElementById("cropDoneBtn").addEventListener("click", closeCropModal);
  cropBackdrop.addEventListener("click", (e) => { if (e.target === cropBackdrop) closeCropModal(); });

  adjustImageBtn.addEventListener("click", openCropModal);

  // ---------- 親キャラクター選択 ----------
  function renderParentSelect(selectedId){
    parentSelect.innerHTML = '<option value="">なし</option>';
    entries.filter(e => e.id !== editingId).forEach(e => {
      const opt = document.createElement("option");
      opt.value = e.id;
      opt.textContent = e.name;
      parentSelect.appendChild(opt);
    });
    parentSelect.value = selectedId || "";
  }

  // ---------- Form modal open/close ----------
  function openForm(entry){
    editingId = entry ? entry.id : null;
    formTitle.textContent = entry ? "登録内容を編集" : "新規登録";
    nameInput.value = entry ? entry.name : "";
    promptInput.value = entry ? (entry.prompt || "") : "";
    negativeInput.value = entry ? entry.negative : "";
    notesInput.value = entry ? entry.notes : "";
    modelInput.value = entry ? (entry.model || "") : "";
    samplerInput.value = entry ? (entry.sampler || "") : "";
    stepsInput.value = entry ? (entry.steps || "") : "";
    cfgInput.value = entry ? (entry.cfgScale || "") : "";
    shiftInput.value = entry ? (entry.shift || "") : "";
    renderParentSelect(entry ? entry.parentId : "");
    updatePromptCharCounter();
    currentTags = entry ? [...entry.tags] : [];
    currentThumb = entry ? entry.thumb : null;
    currentThumbTransform = entry && entry.thumbTransform ? { ...entry.thumbTransform } : { scale: 1, x: 0, y: 0 };
    currentThumbAspect = entry ? (entry.thumbAspect ?? null) : null;
    currentLoras = entry && entry.loras ? entry.loras.map(l => ({...l})) : [];
    renderTagEditor();
    renderThumbPreview();
    renderLoraList();
    formDictCategory = null;
    formDictQuery = "";
    formDictTarget = "prompt";
    formDictSearch.value = "";
    document.getElementById("dictTargetPrompt").checked = true;
    renderFormDictPicker();
    formOverlay.classList.add("open");
    setTimeout(() => nameInput.focus(), 50);
  }
  function closeForm(){ formOverlay.classList.remove("open"); imageInput.value = ""; }
  function renderThumbPreview(){
    if (currentThumb){
      thumbPreview.innerHTML = `<img src="${currentThumb}" alt="">`;
      applyThumbStyle(thumbPreview.querySelector("img"), currentThumbTransform, currentThumbAspect);
      removeImageBtn.style.display = "";
      adjustImageBtn.style.display = "";
    } else {
      thumbPreview.innerHTML = `<span class="placeholder">🖼️</span>`;
      removeImageBtn.style.display = "none";
      adjustImageBtn.style.display = "none";
    }
  }

  document.getElementById("openAddBtn").addEventListener("click", () => openForm(null));
  document.getElementById("formCloseBtn").addEventListener("click", closeForm);
  document.getElementById("formCancelBtn").addEventListener("click", closeForm);
  formOverlay.addEventListener("click", (e) => { if (e.target === formOverlay) closeForm(); });

  document.getElementById("pickImageBtn").addEventListener("click", () => imageInput.click());
  document.getElementById("removeImageBtn").addEventListener("click", () => {
    currentThumb = null;
    currentThumbTransform = { scale: 1, x: 0, y: 0 };
    currentThumbAspect = null;
    renderThumbPreview();
  });
  imageInput.addEventListener("change", async () => {
    const file = imageInput.files[0];
    if (!file) return;
    try{
      const { dataUrl, aspect } = await resizeImage(file, THUMB_MAX_DIM);
      currentThumb = dataUrl;
      currentThumbAspect = aspect;
      currentThumbTransform = { scale: 1, x: 0, y: 0 };
      renderThumbPreview();
      openCropModal();
    }
    catch(err){ console.error(err); showToast("画像の読み込みに失敗しました"); }
  });

  document.getElementById("formSaveBtn").addEventListener("click", async () => {
    if (tagInput.value.trim()) addTagFromInput();
    const name = nameInput.value.trim();
    if (!name){ showToast("名前を入力してください"); nameInput.focus(); return; }
    const now = Date.now();
    const cleanedLoras = currentLoras.filter(l => l.name.trim() || l.strength.trim())
      .map(l => ({ name: l.name.trim(), strength: l.strength.trim() }));
    const entry = {
      id: editingId || uid(),
      name,
      tags: currentTags,
      prompt: promptInput.value.trim(),
      negative: negativeInput.value.trim(),
      notes: notesInput.value.trim(),
      model: modelInput.value.trim(),
      sampler: samplerInput.value.trim(),
      steps: stepsInput.value.trim(),
      cfgScale: cfgInput.value.trim(),
      shift: shiftInput.value.trim(),
      parentId: parentSelect.value || null,
      loras: cleanedLoras,
      thumb: currentThumb,
      thumbTransform: { ...currentThumbTransform },
      thumbAspect: currentThumbAspect,
      createdAt: editingId ? (entries.find(x => x.id === editingId)?.createdAt || now) : now,
      updatedAt: now
    };
    await dbPut(entry);
    await loadEntries();
    closeForm();
    showToast(editingId ? "更新しました" : "登録しました");
  });

  // ---------- 関連キャラクター（親子関係） ----------
  function renderDetailRelations(entry){
    const parent = entry.parentId ? entries.find(e => e.id === entry.parentId) : null;
    const children = entries.filter(e => e.parentId === entry.id);
    if (!parent && !children.length){
      detailRelationsSection.style.display = "none";
      detailRelations.innerHTML = "";
      return;
    }
    detailRelationsSection.style.display = "";
    let html = "";
    if (parent){
      html += `<div class="relation-row"><span class="relation-label">派生元</span><button type="button" class="mini-tag relation-link" data-id="${escapeHtml(parent.id)}">${escapeHtml(parent.name)}</button></div>`;
    }
    if (children.length){
      html += `<div class="relation-row"><span class="relation-label">派生キャラクター</span><div class="relation-chip-list">${
        children.map(c => `<button type="button" class="mini-tag relation-link" data-id="${escapeHtml(c.id)}">${escapeHtml(c.name)}</button>`).join("")
      }</div></div>`;
    }
    detailRelations.innerHTML = html;
    detailRelations.querySelectorAll(".relation-link").forEach(btn => {
      btn.addEventListener("click", () => {
        const target = entries.find(e => e.id === btn.dataset.id);
        if (target) openDetail(target);
      });
    });
  }

  // ---------- Detail modal ----------
  function openDetail(entry){
    detailEntryId = entry.id;
    detailThumb.innerHTML = entry.thumb ? `<img src="${entry.thumb}" alt="">` : `<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:30px;opacity:.35;">🖼️</div>`;
    if (entry.thumb) applyThumbStyle(detailThumb.querySelector("img"), entry.thumbTransform, entry.thumbAspect);
    detailName.textContent = entry.name;
    detailTags.innerHTML = entry.tags.length ? entry.tags.map(t => `<span class="mini-tag">${escapeHtml(t)}</span>`).join("") : `<span class="mini-tag">タグなし</span>`;
    detailDate.textContent = "登録日：" + formatDate(entry.createdAt);

    renderDetailRelations(entry);

    detailPromptText.textContent = entry.prompt || "プロンプトは登録されていません";
    detailPromptText.className = "detail-pre" + (entry.prompt ? "" : " empty-note");
    const promptGroups = entry.prompt ? categorizePromptText(entry.prompt) : [];
    detailPromptGroups.innerHTML = promptGroups.map(g => `
      <div class="prompt-group">
        <div class="prompt-group-title">${escapeHtml(g.category)}</div>
        <div class="prompt-group-tags">${g.tags.map(t => `<span class="mini-tag">${escapeHtml(t)}</span>`).join("")}</div>
      </div>`).join("");

    detailNegative.textContent = entry.negative || "ネガティブプロンプトは登録されていません";
    detailNegative.className = "detail-pre" + (entry.negative ? "" : " empty-note");

    const settingsItems = [
      ["VAEモデル", entry.model],
      ["Sampling Method", entry.sampler],
      ["ステップ数", entry.steps],
      ["CFGスケール", entry.cfgScale],
      ["シフト値", entry.shift],
    ].filter(([,v]) => v);
    let html = settingsItems.map(([k,v]) => `<div class="item"><div class="k">${escapeHtml(k)}</div><div class="v">${escapeHtml(v)}</div></div>`).join("");
    if (entry.loras && entry.loras.length){
      html += `<div class="item" style="grid-column:1/-1;"><div class="k">LoRA</div><div class="lora-chip-list">${
        entry.loras.map(l => `<span class="lora-chip">${escapeHtml(l.name)}${l.strength ? " (" + escapeHtml(l.strength) + ")" : ""}</span>`).join("")
      }</div></div>`;
    }
    detailSettingsGrid.innerHTML = html || `<div class="detail-pre empty-note" style="grid-column:1/-1;">生成設定は登録されていません</div>`;

    if (entry.notes){
      detailNotesSection.style.display = "";
      detailNotes.textContent = entry.notes;
      detailNotes.className = "detail-pre";
    } else {
      detailNotesSection.style.display = "none";
    }

    detailOverlay.classList.add("open");
  }
  function closeDetail(){ detailOverlay.classList.remove("open"); detailEntryId = null; }

  document.getElementById("detailCloseBtn").addEventListener("click", closeDetail);
  detailOverlay.addEventListener("click", (e) => { if (e.target === detailOverlay) closeDetail(); });
  document.getElementById("detailEditBtn").addEventListener("click", () => {
    const entry = entries.find(x => x.id === detailEntryId);
    closeDetail();
    if (entry) openForm(entry);
  });
  document.getElementById("detailPromptCopyBtn").addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    const entry = entries.find(x => x.id === detailEntryId);
    if (entry) copyText(entry.prompt);
  });
  document.getElementById("detailNegativeCopyBtn").addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    const entry = entries.find(x => x.id === detailEntryId);
    if (entry) copyText(entry.negative);
  });

  // ---------- Delete confirm ----------
  let pendingDeleteId = null;
  document.getElementById("detailDeleteBtn").addEventListener("click", () => {
    pendingDeleteId = detailEntryId;
    confirmOverlay.classList.add("open");
  });
  document.getElementById("confirmCancelBtn").addEventListener("click", () => { confirmOverlay.classList.remove("open"); pendingDeleteId = null; });
  document.getElementById("confirmDeleteBtn").addEventListener("click", async () => {
    if (pendingDeleteId){ await dbDelete(pendingDeleteId); await loadEntries(); showToast("削除しました"); }
    confirmOverlay.classList.remove("open");
    pendingDeleteId = null;
    closeDetail();
  });
  confirmOverlay.addEventListener("click", (e) => { if (e.target === confirmOverlay){ confirmOverlay.classList.remove("open"); pendingDeleteId = null; } });

  // ---------- Filtering / sorting / rendering (list) ----------
  function getAllTags(){
    const set = new Set();
    entries.forEach(e => e.tags.forEach(t => set.add(t)));
    return [...set].sort((a,b) => a.localeCompare(b, "ja"));
  }
  function renderTagFilterRow(){
    const tags = getAllTags();
    tagFilterRow.innerHTML = "";
    tags.forEach(tag => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "tag-chip" + (activeTags.has(tag) ? " active" : "");
      chip.textContent = tag;
      chip.addEventListener("click", () => {
        if (activeTags.has(tag)) activeTags.delete(tag); else activeTags.add(tag);
        renderTagFilterRow(); renderGrid();
      });
      tagFilterRow.appendChild(chip);
    });
    if (activeTags.size){
      const clearBtn = document.createElement("button");
      clearBtn.className = "clear-filters";
      clearBtn.textContent = "絞り込みを解除";
      clearBtn.addEventListener("click", () => { activeTags.clear(); renderTagFilterRow(); renderGrid(); });
      tagFilterRow.appendChild(clearBtn);
    }
  }
  function getFiltered(){
    const q = searchQuery.trim().toLowerCase();
    let list = entries.filter(e => {
      const matchesSearch = !q ||
        e.name.toLowerCase().includes(q) ||
        e.tags.some(t => t.toLowerCase().includes(q)) ||
        (e.model || "").toLowerCase().includes(q);
      const matchesTags = activeTags.size === 0 || e.tags.some(t => activeTags.has(t));
      return matchesSearch && matchesTags;
    });
    list.sort((a,b) => {
      switch(sortMode){
        case "date-asc": return a.createdAt - b.createdAt;
        case "name-asc": return a.name.localeCompare(b.name, "ja");
        case "name-desc": return b.name.localeCompare(a.name, "ja");
        case "date-desc": default: return b.createdAt - a.createdAt;
      }
    });
    return list;
  }
  function renderGrid(){
    const list = getFiltered();
    countPill.textContent = entries.length + "件";
    grid.innerHTML = "";
    if (entries.length === 0){
      emptyState.style.display = "flex";
      emptyText.innerHTML = "まだ何も登録されていません。<br>「＋ 新規登録」から最初のキャラクターを追加しましょう。";
      return;
    }
    if (list.length === 0){
      emptyState.style.display = "flex";
      emptyText.innerHTML = "条件に一致する登録がありません。";
      return;
    }
    emptyState.style.display = "none";
    list.forEach(entry => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "card";
      const tagsHtml = entry.tags.slice(0,3).map(t => `<span class="mini-tag">${escapeHtml(t)}</span>`).join("");
      let thumbHtml = `<span class="placeholder">🖼️</span>`;
      if (entry.thumb){
        const style = buildImageStyle({ transform: entry.thumbTransform, frameAspect: FRAME_ASPECT, imageAspect: entry.thumbAspect });
        thumbHtml = `<img src="${entry.thumb}" alt="${escapeHtml(entry.name)}" style="object-fit:${style.objectFit};transform:${style.transform};">`;
      }
      card.innerHTML = `
        <div class="thumb">${thumbHtml}</div>
        <div class="card-body">
          <div class="card-name">${escapeHtml(entry.name)}</div>
          ${entry.model ? `<div class="card-model">${escapeHtml(entry.model)}</div>` : ""}
          <div class="card-tags">${tagsHtml}</div>
        </div>
      `;
      card.addEventListener("click", () => openDetail(entry));
      grid.appendChild(card);
    });
  }

  searchInput.addEventListener("input", () => { searchQuery = searchInput.value; renderGrid(); });
  sortSelect.addEventListener("change", () => { sortMode = sortSelect.value; renderGrid(); });

  // ---------- Migration for legacy entries ----------
  // 旧: promptTags配列（タグ+カテゴリ）→ 新: prompt プレーンテキストに変換
  function migrateEntry(e){
    if (typeof e.prompt !== "string"){
      e.prompt = Array.isArray(e.promptTags) ? e.promptTags.map(t => t.text).join(", ") : "";
    }
    if (!e.thumbTransform) e.thumbTransform = { scale: 1, x: 0, y: 0 };
    if (typeof e.thumbAspect !== "number") e.thumbAspect = null;
    if (typeof e.parentId === "undefined") e.parentId = null;
    if (!e.loras) e.loras = [];
    if (!e.tags) e.tags = [];
    return e;
  }

  // ---------- Load ----------
  async function loadEntries(){
    const raw = await dbGetAll();
    entries = raw.map(migrateEntry);
    renderTagFilterRow();
    renderGrid();
  }

  // ---------- Export / Import (JSON backup) ----------
  const importFileInput = document.getElementById("importFileInput");
  const importConfirmOverlay = document.getElementById("importConfirmOverlay");
  const importConfirmText = document.getElementById("importConfirmText");
  let pendingImportData = null;

  document.getElementById("exportBtn").addEventListener("click", async () => {
    const allEntries = await dbGetAll();
    const data = {
      app: "character-library-backup",
      version: 2,
      exportedAt: new Date().toISOString(),
      entries: allEntries.map(migrateEntry)
    };
    try{
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const stamp = new Date().toISOString().slice(0,10);
      a.href = url;
      a.download = `character-library-backup-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      showToast(`${data.entries.length}件を書き出しました`);
    }catch(err){
      console.error(err);
      showToast("書き出しに失敗しました");
    }
  });

  document.getElementById("importBtn").addEventListener("click", () => importFileInput.click());

  importFileInput.addEventListener("change", async () => {
    const file = importFileInput.files[0];
    if (!file) return;
    try{
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data || !Array.isArray(data.entries)) throw new Error("invalid format");
      pendingImportData = data;
      importConfirmText.textContent =
        `このファイルには ${data.entries.length}件 の登録が含まれています。` +
        `現在の登録（${entries.length}件）に追加しますか、それとも全て置き換えますか？`;
      importConfirmOverlay.classList.add("open");
    }catch(err){
      console.error(err);
      showToast("読み込みに失敗しました。JSONファイルの形式を確認してください");
    }finally{
      importFileInput.value = "";
    }
  });

  async function performImport(mode){
    const data = pendingImportData;
    if (!data) return;
    if (mode === "replace"){
      const existing = await dbGetAll();
      for (const e of existing) await dbDelete(e.id);
    }
    for (const rawEntry of data.entries){
      const normalized = migrateEntry({ ...rawEntry });
      if (!normalized.id) normalized.id = uid();
      await dbPut(normalized);
    }
    await loadEntries();
    showToast(mode === "replace" ? "置き換えてインポートしました" : "追加でインポートしました");
    pendingImportData = null;
    importConfirmOverlay.classList.remove("open");
  }

  document.getElementById("importCancelBtn").addEventListener("click", () => {
    pendingImportData = null;
    importConfirmOverlay.classList.remove("open");
  });
  document.getElementById("importMergeBtn").addEventListener("click", () => performImport("merge"));
  document.getElementById("importReplaceBtn").addEventListener("click", () => performImport("replace"));
  importConfirmOverlay.addEventListener("click", (e) => {
    if (e.target === importConfirmOverlay){ pendingImportData = null; importConfirmOverlay.classList.remove("open"); }
  });

  loadEntries();
})();
