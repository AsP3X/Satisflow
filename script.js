// ────────────────────────────────────────────────
const canvas = document.getElementById('canvas');
const svg = document.getElementById('svg-container');
const wrapper = document.getElementById('canvas-wrapper');

let nodes = [];
let connections = [];
let nodeById = new Map();
let nodeCounter = 0;
let scale = 1;
let translateX = 0, translateY = 0;
let selectedNodes = new Set();
let updateLinesRaf = null;
let pendingUpdateNodeId = null;

const MAX_UNDO = 50;
let undoStack = [];
let redoStack = [];

// Config loaded from config.json
let APP_CONFIG = null;
let machinesList = [];
let recipesByMachine = {};
let recipeListByMachine = {};

const MACHINE_ICONS = { miner: '⛏️', smelter: '♨️', constructor: '🔩', assembler: '⚙️', foundry: '🏭', refinery: '🛢️', storage_container: '📦', splitter: '⇉', merger: '⇄' };

function buildConfigLookups() {
  if (!APP_CONFIG || !APP_CONFIG.machines || !APP_CONFIG.recipes) return;
  machinesList = [];
  recipesByMachine = {};
  recipeListByMachine = {};
  for (const [type, def] of Object.entries(APP_CONFIG.machines)) {
    const name = def.name || type;
    (def.tiers || []).forEach(tier => {
      machinesList.push({
        type,
        tierId: tier.id || 'mk1',
        tierName: tier.name || 'Mk.1',
        label: `${name} ${tier.name || ''}`.trim(),
        icon: MACHINE_ICONS[type] || '📦'
      });
    });
  }
  // Satisfactory crafting formula: output per minute (at 100% clock) = (items per cycle / cycle time in sec) × 60. Recipe amounts = per cycle.
  for (const recipe of APP_CONFIG.recipes) {
    const machine = recipe.machine;
    if (!machine) continue;
    if (!Array.isArray(recipesByMachine[machine])) recipesByMachine[machine] = [];
    const out = recipe.outputs && recipe.outputs[0];
    const outPerMin = out ? (out.amount / recipe.craftingTimeSeconds) * 60 : 0;
    const ins = (recipe.inputs || []).map(inp => ({ item: inp.item, amount: (inp.amount / recipe.craftingTimeSeconds) * 60 }));
    const r = {
      id: recipe.id,
      name: recipe.name,
      item: out?.item || recipe.name,
      craftingTimeSeconds: recipe.craftingTimeSeconds,
      inputs: recipe.inputs || [],
      outputs: recipe.outputs || [],
      in: ins[0]?.amount,
      in2: ins[1]?.amount,
      in3: ins[2]?.amount,
      in4: ins[3]?.amount,
      out: outPerMin
    };
    recipesByMachine[machine].push(r);
    if (!Array.isArray(recipeListByMachine[machine])) recipeListByMachine[machine] = [];
    recipeListByMachine[machine].push(r);
  }
}

function saveState() {
  undoStack.push(serializeState());
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack = [];
}
function serializeState() {
  return {
    nodes: nodes.map(n => ({
      id: n.dataset.id,
      type: n.dataset.type,
      tier: n.dataset.tier,
      x: parseFloat(n.style.left),
      y: parseFloat(n.style.top),
      rate: n.dataset.rate,
      item: n.dataset.item,
      miningRate: n.dataset.miningRate,
      oreQuality: n.dataset.oreQuality,
      name: n.querySelector('.node-header')?.textContent?.trim()
    })),
    connections: connections.map(c => ({ ...c })),
    nodeCounter
  };
}
function restoreState(state) {
  nodes.forEach(n => n.remove());
  nodes = [];
  nodeById.clear();
  connections = [];
  state.nodes.forEach(nd => {
    const node = createNodeFromData(nd);
    nodes.push(node);
    nodeById.set(node.dataset.id, node);
  });
  nodeCounter = state.nodeCounter != null ? state.nodeCounter : (Math.max(0, ...state.nodes.map(n => Number(n.id))) + 1);
  state.connections.forEach(c => {
    const fromNode = nodes.find(n => n.dataset.id === String(c.fromNode));
    const toNode = nodes.find(n => n.dataset.id === String(c.toNode));
    if (!fromNode || !toNode) return;
    const fromPort = fromNode.querySelector('.port.output');
    const toPort = findPortByClass(toNode, c.toPort) || toNode.querySelector('.port.input');
    if (fromPort && toPort) {
      connections.push({
        fromNode: fromNode.dataset.id,
        fromPort: fromPort.className,
        toNode: toNode.dataset.id,
        toPort: toPort.className
      });
      drawConnection(fromPort, toPort);
    }
  });
  updateAllLines();
  nodes.forEach(n => updateNodeInputLabels(n));
}
function getMachineDef(type) {
  return APP_CONFIG && APP_CONFIG.machines ? APP_CONFIG.machines[type] : null;
}

function getInputCount(type) {
  const def = getMachineDef(type);
  return def && def.inputCount != null ? def.inputCount : (type === 'miner' ? 0 : type === 'smelter' ? 1 : type === 'constructor' ? 2 : type === 'assembler' ? 2 : type === 'foundry' ? 2 : type === 'storage_container' ? 1 : type === 'splitter' ? 1 : type === 'merger' ? 3 : 3);
}

function getOutputCount(type) {
  const def = getMachineDef(type);
  return def && def.outputCount != null ? def.outputCount : 1;
}

function createNodeFromData(nd) {
  const type = nd.type || 'miner';
  const tier = nd.tier || 'mk1';
  const node = document.createElement('div');
  node.className = 'node';
  node.style.left = (nd.x || 0) + 'px';
  node.style.top = (nd.y || 0) + 'px';
  node.dataset.id = String(nd.id);
  node.dataset.type = type;
  node.dataset.tier = tier;
  node.dataset.rate = nd.rate || '0';
  node.dataset.item = nd.item || getDefaultItem(type);
  if (type === 'miner') {
    node.dataset.oreQuality = nd.oreQuality || getMinerDefaultOreQualityId();
    const calcRate = getMinerCalculatedRate(tier, node.dataset.oreQuality);
    node.dataset.rate = String(calcRate);
    node.dataset.miningRate = String(calcRate);
  } else if (type === 'smelter') {
    const calcRate = getCraftingMachineCalculatedRate(type, tier, node.dataset.item);
    node.dataset.rate = String(calcRate);
  }
  const icon = MACHINE_ICONS[type] || '📦';
  const def = getMachineDef(type);
  const tierDef = (def && def.tiers) ? (def.tiers.find(t => t.id === tier) || def.tiers[0]) : null;
  const tierName = tierDef?.name || tier || '';
  const flowSuffix = (type === 'splitter' || type === 'merger') && tierDef && tierDef.maxFlowPerMin != null ? ` · ${tierDef.maxFlowPerMin}/min` : '';
  const label = nd.name || `${icon} ${def?.name || type} ${tierName}${flowSuffix}`.trim();
  const productName = node.dataset.item || '';
  node.innerHTML = `
    <div class="node-header">${label}</div>
    <div class="node-product">${productName}</div>
  `;
  const portsContainer = document.createElement('div');
  portsContainer.style.cssText = 'position:absolute;inset:0;pointer-events:auto';
  const outputCount = getOutputCount(type);
  for (let i = 1; i <= outputCount; i++) portsContainer.appendChild(createPort('output', outputCount > 1 ? 'output-' + i : 'output'));
  const inputCount = getInputCount(type);
  for (let i = 1; i <= inputCount; i++) portsContainer.appendChild(createInputPortWithLabel('input-' + i));
  node.appendChild(portsContainer);
  canvas.appendChild(node);
  makeDraggable(node);
  node.addEventListener('dblclick', () => editNode(node));
  node.addEventListener('contextmenu', e => showNodeContextMenu(e, node));
  node.addEventListener('mousedown', e => { if (e.button === 0 && !e.target.closest('.port')) selectNode(node, e.shiftKey); });
  node.querySelectorAll('.port').forEach(port => {
    port.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      startConnectionDrag(port, e);
    });
  });
  updateNodeInputLabels(node);
  return node;
}
function selectNode(node, addToSelection) {
  if (!addToSelection) selectedNodes.clear();
  selectedNodes.add(node);
  nodes.forEach(n => n.classList.toggle('selected', selectedNodes.has(n)));
}
function deselectAll() {
  selectedNodes.clear();
  nodes.forEach(n => n.classList.remove('selected'));
}

// ─── Toast ───────────────────────────────────────
function toast(message, isWarning = false) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.toggle('warning', isWarning);
  el.classList.add('show');
  clearTimeout(el._toastTimer);
  el._toastTimer = setTimeout(() => { el.classList.remove('show'); }, 3000);
}

// ─── Theme (persisted) ────────────────────────────
function updateThemeToggleIcon() {
  const btn = document.getElementById('theme-toggle');
  const icon = btn.querySelector('i');
  const isDark = document.documentElement.dataset.theme !== 'light';
  icon.className = isDark ? 'fas fa-sun' : 'fas fa-moon';
  btn.title = isDark ? 'Switch to light theme' : 'Switch to dark theme';
  btn.setAttribute('aria-label', btn.title);
}
const savedTheme = localStorage.getItem('satisflow-theme');
if (savedTheme) document.documentElement.dataset.theme = savedTheme;
updateThemeToggleIcon();
document.getElementById('theme-toggle').onclick = () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('satisflow-theme', next);
  updateThemeToggleIcon();
};

// ─── Zoom / Pan ──────────────────────────────────
function updateTransform() {
  canvas.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
  scheduleUpdateLines();
}
function scheduleUpdateLines() {
  if (updateLinesRaf) return;
  updateLinesRaf = requestAnimationFrame(() => {
    updateLinesRaf = null;
    updateAllLines();
  });
}

wrapper.addEventListener('wheel', e => {
  e.preventDefault();
  if (e.deltaY < 0) scale = Math.min(scale + 0.1, 3);
  else             scale = Math.max(scale - 0.1, 0.3);
  updateTransform();
});

let isPanning = false, panStartX, panStartY;
wrapper.addEventListener('mousedown', e => {
  if (e.button === 1 || (e.button === 0 && e.altKey)) {
    isPanning = true;
    panStartX = e.clientX - translateX;
    panStartY = e.clientY - translateY;
    wrapper.style.cursor = 'grabbing';
  }
});
window.addEventListener('mousemove', e => {
  if (!isPanning) return;
  translateX = e.clientX - panStartX;
  translateY = e.clientY - panStartY;
  updateTransform();
});
window.addEventListener('mouseup', () => {
  isPanning = false;
  wrapper.style.cursor = 'default';
});
let touchPanStartX = 0, touchPanStartY = 0, touchStartTranslateX = 0, touchStartTranslateY = 0;
wrapper.addEventListener('touchstart', e => {
  if (e.touches.length === 2) {
    isPanning = true;
    touchPanStartX = e.touches[0].clientX;
    touchPanStartY = e.touches[0].clientY;
    touchStartTranslateX = translateX;
    touchStartTranslateY = translateY;
  }
}, { passive: true });
wrapper.addEventListener('touchmove', e => {
  if (e.touches.length === 2 && isPanning) {
    e.preventDefault();
    translateX = touchStartTranslateX + (touchPanStartX - e.touches[0].clientX);
    translateY = touchStartTranslateY + (touchPanStartY - e.touches[0].clientY);
    updateTransform();
  }
}, { passive: false });
wrapper.addEventListener('touchend', e => {
  if (e.touches.length < 2) isPanning = false;
});

document.getElementById('zoom-in').onclick = () => { scale = Math.min(scale + 0.2, 3); updateTransform(); };
document.getElementById('zoom-out').onclick = () => { scale = Math.max(scale - 0.2, 0.3); updateTransform(); };
document.getElementById('zoom-reset').onclick = () => { scale = 1; translateX = translateY = 0; updateTransform(); };
document.getElementById('zoom-fit').onclick = () => {
  if (nodes.length === 0) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  nodes.forEach(n => {
    const x = parseFloat(n.style.left);
    const y = parseFloat(n.style.top);
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + 160); maxY = Math.max(maxY, y + 90);
  });
  const w = maxX - minX + 80, h = maxY - minY + 80;
  const r = wrapper.getBoundingClientRect();
  scale = Math.min(r.width / w, r.height / h, 2);
  translateX = r.width / 2 - (minX + maxX) / 2 * scale;
  translateY = r.height / 2 - (minY + maxY) / 2 * scale;
  updateTransform();
};
document.getElementById('zoom-selection').onclick = () => {
  const sel = [...selectedNodes];
  if (sel.length === 0) { toast('Select one or more nodes first'); return; }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  sel.forEach(n => {
    const x = parseFloat(n.style.left);
    const y = parseFloat(n.style.top);
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + 160); maxY = Math.max(maxY, y + 90);
  });
  const w = maxX - minX + 80, h = maxY - minY + 80;
  const r = wrapper.getBoundingClientRect();
  scale = Math.min(r.width / w, r.height / h, 2);
  translateX = r.width / 2 - (minX + maxX) / 2 * scale;
  translateY = r.height / 2 - (minY + maxY) / 2 * scale;
  updateTransform();
};

// ─── Keyboard ────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (editOverlay.classList.contains('show')) closeEditDialog();
    else if (ctxMenu.classList.contains('show')) closeContextMenu();
    else deselectAll();
    e.preventDefault();
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (document.activeElement && document.activeElement.closest('#edit-dialog')) return;
    if (selectedNodes.size > 0) {
      saveState();
      [...selectedNodes].forEach(n => deleteNode(n));
      deselectAll();
      e.preventDefault();
    }
    return;
  }
  if (e.ctrlKey || e.metaKey) {
    if (e.key === 'z') {
      e.preventDefault();
      if (e.shiftKey) {
        if (redoStack.length) { undoStack.push(serializeState()); restoreState(redoStack.pop()); toast('Redo'); }
      } else {
        if (undoStack.length) { redoStack.push(serializeState()); restoreState(undoStack.pop()); toast('Undo'); }
      }
    } else if (e.key === 'y') {
      e.preventDefault();
      if (redoStack.length) { undoStack.push(serializeState()); restoreState(redoStack.pop()); toast('Redo'); }
    }
  }
});

// ─── Node Creation ───────────────────────────────
wrapper.addEventListener('dragover', e => e.preventDefault());
wrapper.addEventListener('drop', e => {
  e.preventDefault();
  const fromStorage = e.dataTransfer.getData('from-storage');
  const nodeId = e.dataTransfer.getData('node-id');
  if (fromStorage && nodeId) {
    const storageList = document.getElementById('node-storage-list');
    const node = storageList && storageList.querySelector(`[data-id="${nodeId}"]`);
    if (node) {
      const pt = getCanvasPoint(e.clientX, e.clientY);
      const x = pt.x - 80;
      const y = pt.y - 45;
      node.style.left = x + 'px';
      node.style.top = y + 'px';
      node.classList.remove('node-in-storage');
      node.draggable = false;
      node.removeAttribute('draggable');
      storageList.removeChild(node);
      canvas.appendChild(node);
      nodes.push(node);
      nodeById.set(node.dataset.id, node);
      makeDraggable(node);
      node.addEventListener('dblclick', () => editNode(node));
      node.addEventListener('contextmenu', ev => showNodeContextMenu(ev, node));
      node.addEventListener('mousedown', ev => { if (ev.button === 0 && !ev.target.closest('.port')) selectNode(node, ev.shiftKey); });
      node.querySelectorAll('.port').forEach(port => {
        port.addEventListener('mousedown', ev => {
          if (ev.button !== 0) return;
          ev.preventDefault();
          ev.stopPropagation();
          startConnectionDrag(port, ev);
        });
      });
      saveState();
    }
    return;
  }
  const type = e.dataTransfer.getData('type');
  const tier = e.dataTransfer.getData('tier') || 'mk1';
  if (!type) return;
  const rect = wrapper.getBoundingClientRect();
  let x = (e.clientX - rect.left - translateX) / scale - 80;
  let y = (e.clientY - rect.top  - translateY) / scale - 45;
  saveState();
  createNode(type, x, y, e.dataTransfer.getData('icon') || MACHINE_ICONS[type], tier);
});
wrapper.addEventListener('mousedown', e => {
  if (e.target === wrapper || e.target.closest('#canvas') && !e.target.closest('.node')) deselectAll();
});

let canvasContextMenuDropX = 0;
let canvasContextMenuDropY = 0;
let lastCanvasRightclickClientX = 0;
let lastCanvasRightclickClientY = 0;

let canvasContextMenuData = { categories: [], byType: {}, selectedType: null };

function renderCanvasContextMenuItems() {
  const itemsEl = document.getElementById('canvas-context-menu-items');
  const searchEl = document.getElementById('canvas-context-menu-search');
  const query = (searchEl && searchEl.value) ? searchEl.value.trim().toLowerCase() : '';
  const type = canvasContextMenuData.selectedType;
  if (!itemsEl || !type) return;
  const items = canvasContextMenuData.byType[type] || [];
  const filtered = query
    ? items.filter(m => (m.label || '').toLowerCase().includes(query))
    : items;
  itemsEl.innerHTML = '';
  filtered.forEach(({ type: machineType, tierId, label, icon }) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ctx-item';
    btn.innerHTML = `<span class="ctx-item-icon">${icon}</span><span class="ctx-item-label">${label}</span>`;
    btn.addEventListener('click', ev => {
      ev.stopPropagation();
      saveState();
      createNodeInStorage(machineType, icon, tierId);
    });
    itemsEl.appendChild(btn);
  });
}

function openNodeWindow(clientX, clientY) {
  const pt = getCanvasPoint(clientX, clientY);
  canvasContextMenuDropX = pt.x;
  canvasContextMenuDropY = pt.y;
  const menu = document.getElementById('canvas-context-menu');
  const categoriesEl = document.getElementById('canvas-context-menu-categories');
  const itemsEl = document.getElementById('canvas-context-menu-items');
  const searchEl = document.getElementById('canvas-context-menu-search');
  if (!menu || !categoriesEl || !itemsEl) return;

  const machineOrder = APP_CONFIG && APP_CONFIG.machines ? Object.keys(APP_CONFIG.machines) : [];
  const byType = {};
  machinesList.forEach(m => {
    if (!Array.isArray(byType[m.type])) byType[m.type] = [];
    byType[m.type].push(m);
  });
  const categories = [];
  machineOrder.forEach(type => {
    const items = byType[type];
    if (!items || !items.length) return;
    const def = getMachineDef(type);
    const categoryName = def ? def.name : (type.charAt(0).toUpperCase() + type.slice(1));
    categories.push({ type, name: categoryName });
  });

  canvasContextMenuData = { categories, byType, selectedType: categories[0] ? categories[0].type : null };

  categoriesEl.innerHTML = '';
  categories.forEach(({ type, name }) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ctx-category-btn';
    btn.dataset.type = type;
    btn.textContent = name;
    if (type === canvasContextMenuData.selectedType) btn.classList.add('active');
    btn.addEventListener('click', ev => {
      ev.stopPropagation();
      canvasContextMenuData.selectedType = type;
      categoriesEl.querySelectorAll('.ctx-category-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderCanvasContextMenuItems();
    });
    categoriesEl.appendChild(btn);
  });

  if (searchEl) {
    searchEl.value = '';
    searchEl.oninput = () => renderCanvasContextMenuItems();
  }
  renderCanvasContextMenuItems();

  menu.style.left = clientX + 'px';
  menu.style.top = clientY + 'px';
  menu.style.width = '1120px';
  menu.style.height = '630px';
  menu.classList.add('show');
  setTimeout(() => { if (searchEl) searchEl.focus(); }, 0);
}

function closeCanvasContextMenu() {
  const menu = document.getElementById('canvas-context-menu');
  if (menu) {
    menu.classList.remove('show');
    if (menu._outsideClickHandler) {
      document.removeEventListener('click', menu._outsideClickHandler);
      menu._outsideClickHandler = null;
    }
  }
}

function showCanvasRightclickMenu(clientX, clientY) {
  lastCanvasRightclickClientX = clientX;
  lastCanvasRightclickClientY = clientY;
  const menu = document.getElementById('canvas-rightclick-menu');
  if (!menu) return;
  menu.style.left = clientX + 'px';
  menu.style.top = clientY + 'px';
  menu.classList.add('show');
  function onDocumentClick(ev) {
    if (menu.contains(ev.target)) return;
    closeCanvasRightclickMenu();
    document.removeEventListener('click', onDocumentClick);
  }
  menu._outsideClickHandler = onDocumentClick;
  setTimeout(() => document.addEventListener('click', onDocumentClick), 0);
}

function closeCanvasRightclickMenu() {
  const menu = document.getElementById('canvas-rightclick-menu');
  if (menu) {
    menu.classList.remove('show');
    if (menu._outsideClickHandler) {
      document.removeEventListener('click', menu._outsideClickHandler);
      menu._outsideClickHandler = null;
    }
  }
}

function setupCanvasContextMenu() {
  const menu = document.getElementById('canvas-context-menu');
  const header = document.getElementById('canvas-context-menu-header');
  const resizeHandle = document.getElementById('canvas-context-menu-resize');
  const closeBtn = document.getElementById('canvas-context-menu-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', e => {
      e.stopPropagation();
      closeCanvasContextMenu();
    });
  }
  if (header) {
    header.addEventListener('mousedown', e => {
      if (e.button !== 0 || e.target.closest('input') || e.target.closest('#canvas-context-menu-close')) return;
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const startLeft = parseFloat(menu.style.left) || 0;
      const startTop = parseFloat(menu.style.top) || 0;
      function onMove(ev) {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        menu.style.left = (startLeft + dx) + 'px';
        menu.style.top = (startTop + dy) + 'px';
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }
  if (resizeHandle) {
    resizeHandle.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startY = e.clientY;
      const startW = parseFloat(menu.style.width) || menu.offsetWidth;
      const startH = parseFloat(menu.style.height) || menu.offsetHeight;
      const minW = 400;
      const minH = 280;
      const maxW = Math.min(window.innerWidth * 0.95, 9999);
      const maxH = Math.min(window.innerHeight * 0.9, 9999);
      function onMove(ev) {
        let w = startW + (ev.clientX - startX);
        let h = startH + (ev.clientY - startY);
        w = Math.max(minW, Math.min(maxW, w));
        h = Math.max(minH, Math.min(maxH, h));
        menu.style.width = w + 'px';
        menu.style.height = h + 'px';
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }
  const rightclickMenu = document.getElementById('canvas-rightclick-menu');
  if (rightclickMenu) {
    rightclickMenu.querySelector('[data-action="node-window"]')?.addEventListener('click', e => {
      e.stopPropagation();
      closeCanvasRightclickMenu();
      openNodeWindow(lastCanvasRightclickClientX, lastCanvasRightclickClientY);
    });
  }
  document.addEventListener('contextmenu', e => {
    if (!wrapper.contains(e.target)) return;
    if (e.target.closest('.node') || e.target.closest('#zoom-controls')) return;
    e.preventDefault();
    e.stopPropagation();
    closeContextMenu();
    closeCanvasContextMenu();
    showCanvasRightclickMenu(e.clientX, e.clientY);
  }, true);
}

function buildNodeElement(type, x, y, icon, tierId) {
  const node = document.createElement('div');
  node.className = 'node';
  node.style.left = x + 'px';
  node.style.top  = y + 'px';
  node.dataset.id = String(nodeCounter++);
  node.dataset.type = type;
  node.dataset.tier = tierId;
  node.dataset.rate = '0';
  node.dataset.item = getDefaultItem(type);
  if (type === 'miner') {
    node.dataset.oreQuality = getMinerDefaultOreQualityId();
  }
  const def = getMachineDef(type);
  const tier = (def && def.tiers) ? (def.tiers.find(t => t.id === tierId) || def.tiers[0]) : null;
  const tierName = tier?.name || '';
  const slotsSuffix = (def && def.slots) ? ` · ${def.slots} slots` : '';
  const flowSuffix = (type === 'splitter' || type === 'merger') && tier && tier.maxFlowPerMin != null ? ` · ${tier.maxFlowPerMin}/min` : '';
  const typeLabel = def ? `${def.name}${slotsSuffix} ${tierName}${flowSuffix}`.trim() : (type.charAt(0).toUpperCase() + type.slice(1));
  if (type === 'miner') {
    node.dataset.rate = String(getMinerCalculatedRate(tierId, node.dataset.oreQuality));
    node.dataset.miningRate = node.dataset.rate;
  } else if (type === 'smelter') {
    node.dataset.rate = String(getCraftingMachineCalculatedRate(type, tierId, node.dataset.item));
  }
  const productName = node.dataset.item || '';
  node.innerHTML = `
    <div class="node-header">${icon} ${typeLabel}</div>
    <div class="node-product">${productName}</div>
  `;

  const portsContainer = document.createElement('div');
  portsContainer.style.cssText = 'position:absolute;inset:0;pointer-events:auto';
  const outputCount = getOutputCount(type);
  for (let i = 1; i <= outputCount; i++) portsContainer.appendChild(createPort('output', outputCount > 1 ? 'output-' + i : 'output'));
  const inputCount = getInputCount(type);
  for (let i = 1; i <= inputCount; i++) portsContainer.appendChild(createInputPortWithLabel('input-' + i));
  node.appendChild(portsContainer);
  updateNodeInputLabels(node);
  return node;
}

function createNodeInStorage(type, icon = '', tierId = 'mk1') {
  const node = buildNodeElement(type, 0, 0, icon, tierId);
  node.classList.add('node-in-storage');
  node.draggable = true;
  node.addEventListener('dragstart', e => {
    e.dataTransfer.setData('from-storage', '1');
    e.dataTransfer.setData('node-id', node.dataset.id);
    e.dataTransfer.effectAllowed = 'move';
  });
  const storageList = document.getElementById('node-storage-list');
  if (storageList) storageList.appendChild(node);
  return node;
}

function createNode(type, x, y, icon = '', tierId = 'mk1') {
  const node = buildNodeElement(type, x, y, icon, tierId);
  canvas.appendChild(node);
  nodes.push(node);
  nodeById.set(node.dataset.id, node);

  makeDraggable(node);
  node.addEventListener('dblclick', () => editNode(node));
  node.addEventListener('contextmenu', e => showNodeContextMenu(e, node));
  node.addEventListener('mousedown', e => { if (e.button === 0 && !e.target.closest('.port')) selectNode(node, e.shiftKey); });

  node.querySelectorAll('.port').forEach(port => {
    port.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      startConnectionDrag(port, e);
    });
  });

  return node;
}

function createPort(type, className = '') {
  const port = document.createElement('div');
  port.className = `port ${type} ${className}`;
  port.dataset.portType = type;
  return port;
}

function createInputPortWithLabel(portClass) {
  const wrap = document.createElement('div');
  wrap.className = `port-input-wrap ${portClass}`;
  const port = createPort('input', portClass);
  const label = document.createElement('span');
  label.className = 'port-input-label';
  wrap.appendChild(port);
  wrap.appendChild(label);
  return wrap;
}

function updateNodeInputLabels(node) {
  if (!node) return;
  const nodeId = node.dataset.id;
  const type = node.dataset.type;
  const item = node.dataset.item;
  const opts = recipeListByMachine[type] || [];
  const recipe = opts.find(r => (r.item || r.name) === item) || opts[0];
  const wraps = node.querySelectorAll('.port-input-wrap');
  wraps.forEach(wrap => {
    const port = wrap.querySelector('.port');
    const labelEl = wrap.querySelector('.port-input-label');
    if (!port || !labelEl) return;
    const isConnected = connections.some(c => c.toNode === nodeId && c.toPort === port.className);
    if (isConnected) {
      labelEl.textContent = '';
      labelEl.classList.remove('visible');
      return;
    }
    if (!recipe || !recipe.inputs || !recipe.inputs.length) {
      labelEl.textContent = '';
      labelEl.classList.remove('visible');
      return;
    }
    const portClass = port.className;
    const match = portClass.match(/input-(\d+)/);
    const index = match ? parseInt(match[1], 10) - 1 : 0;
    const inp = recipe.inputs[index];
    const rates = [recipe.in, recipe.in2, recipe.in3, recipe.in4];
    const rate = rates[index];
    if (!inp || rate == null) {
      labelEl.textContent = '';
      labelEl.classList.remove('visible');
      return;
    }
    const perMin = Math.round(rate * 10) / 10;
    labelEl.textContent = `${inp.item} ${perMin}/min`;
    labelEl.classList.add('visible');
  });
}

// Satisfactory miner formula: output/min = base rate (Mk.1=60, Mk.2=120, Mk.3=240) × node purity (Impure=0.5, Normal=1, Pure=2).
function getMinerCalculatedRate(tierId, qualityId) {
  const def = getMachineDef('miner');
  if (!def || !def.tiers) return 60;
  const tier = def.tiers.find(t => t.id === tierId) || def.tiers[0];
  const maxOut = tier && tier.maxOutputPerMin != null ? tier.maxOutputPerMin : 60;
  const mult = getMinerOreQualityMultiplier(qualityId);
  return maxOut * mult;
}

function getMinerDefaultRate(tierId) {
  return String(getMinerCalculatedRate(tierId, getMinerDefaultOreQualityId()));
}

function getMinerOreQualities() {
  const def = getMachineDef('miner');
  const list = def && def.oreQualities && Array.isArray(def.oreQualities) ? def.oreQualities : [];
  if (list.length) return list;
  return [{ id: 'normal', name: 'Normal', multiplier: 1 }];
}

function getMinerOreQualityMultiplier(qualityId) {
  const qualities = getMinerOreQualities();
  const q = qualities.find(x => x.id === qualityId) || qualities[0];
  return q && typeof q.multiplier === 'number' ? q.multiplier : 1;
}

function getMinerDefaultOreQualityId() {
  const qualities = getMinerOreQualities();
  return (qualities[0] && qualities[0].id) || 'normal';
}

// Satisfactory crafting: output/min = (items per cycle / cycle time in sec) × 60 × machine crafting speed (tier).
function getCraftingMachineCalculatedRate(type, tierId, itemName) {
  const opts = recipeListByMachine[type];
  if (!opts || !opts.length) return 0;
  const r = opts.find(o => o.item === itemName || o.name === itemName) || opts[0];
  if (!r || r.out == null) return 0;
  const def = getMachineDef(type);
  const tier = (def && def.tiers) ? def.tiers.find(t => t.id === tierId) : null;
  const speed = (tier && tier.craftingSpeed != null) ? tier.craftingSpeed : 1;
  return r.out * speed;
}

function hasCalculatedRate(type) {
  return type === 'miner' || type === 'smelter';
}

function getRecipeForNode(node) {
  const type = node.dataset.type;
  const item = node.dataset.item;
  const tierId = node.dataset.tier || 'mk1';
  const opts = recipeListByMachine[type];
  if (!opts || !opts.length) return null;
  const r = opts.find(o => o.item === item || o.name === item) || opts[0];
  if (!r) return null;
  const def = getMachineDef(type);
  const tier = (def && def.tiers) ? def.tiers.find(t => t.id === tierId) : null;
  const speed = (tier && (tier.craftingSpeed != null)) ? tier.craftingSpeed : (tier && tier.miningSpeed != null) ? tier.miningSpeed : 1;
  if (type === 'miner') {
    const out = getMinerCalculatedRate(node.dataset.tier || 'mk1', node.dataset.oreQuality);
    return { ...r, out };
  }
  return {
    ...r,
    in: r.in != null ? r.in * speed : undefined,
    in2: r.in2 != null ? r.in2 * speed : undefined,
    in3: r.in3 != null ? r.in3 * speed : undefined,
    in4: r.in4 != null ? r.in4 * speed : undefined,
    out: r.out != null ? r.out * speed : undefined
  };
}

function getDefaultItem(type) {
  const opts = recipeListByMachine[type];
  return (opts && opts[0] && (opts[0].item || opts[0].name)) ? (opts[0].item || opts[0].name) : 'Item';
}

// ─── IMPROVED DRAGGABLE ──────────────────────────
function makeDraggable(el) {
  let isDragging = false;
  let startX, startY, startLeft, startTop;

  el.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    if (e.target.closest('.port') || e.target.closest('.node-rate')) return;
    e.preventDefault();
    e.stopPropagation();

    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    startLeft = parseFloat(el.style.left) || 0;
    startTop  = parseFloat(el.style.top)  || 0;

    el.classList.add('dragging');
    el.style.opacity = '0.85';
    el.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';
  });

  const onMouseMove = e => {
    if (!isDragging) return;

    const dxScreen = e.clientX - startX;
    const dyScreen = e.clientY - startY;

    const dxModel = dxScreen / scale;
    const dyModel = dyScreen / scale;

    el.style.left = (startLeft + dxModel) + 'px';
    el.style.top  = (startTop  + dyModel) + 'px';

    pendingUpdateNodeId = el.dataset.id;
    updateAllLines();
  };

  const onMouseUp = () => {
    if (!isDragging) return;
    isDragging = false;
    el.classList.remove('dragging');
    el.style.opacity = '1';
    el.style.cursor = 'move';
    document.body.style.userSelect = '';
  };

  el.addEventListener('touchstart', e => {
    if (e.touches.length !== 1 || e.target.closest('.port')) return;
    e.preventDefault();
    isDragging = true;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    startLeft = parseFloat(el.style.left) || 0;
    startTop = parseFloat(el.style.top) || 0;
    el.classList.add('dragging');
    el.style.opacity = '0.85';
  }, { passive: false });
  el.addEventListener('touchmove', e => {
    if (e.touches.length !== 1 || !isDragging) return;
    e.preventDefault();
    const dx = (e.touches[0].clientX - startX) / scale;
    const dy = (e.touches[0].clientY - startY) / scale;
    el.style.left = (startLeft + dx) + 'px';
    el.style.top = (startTop + dy) + 'px';
    pendingUpdateNodeId = el.dataset.id;
    updateAllLines();
  }, { passive: false });
  el.addEventListener('touchend', () => {
    if (!isDragging) return;
    isDragging = false;
    el.classList.remove('dragging');
    el.style.opacity = '1';
  });

  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);

  el._dragCleanup = () => {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  };
}

// ─── Drag from port to connect ───────────────────
function getCanvasPoint(clientX, clientY) {
  const canvasRect = wrapper.getBoundingClientRect();
  return {
    x: (clientX - canvasRect.left - translateX) / scale,
    y: (clientY - canvasRect.top - translateY) / scale
  };
}

let connectionPreviewLine = null;
let connectionDragSource = null;
let connectionDropHighlight = null;

let addNodeDialogSourcePort = null;
let addNodeDialogDropX = 0;
let addNodeDialogDropY = 0;

function openAddNodeDialog(sourcePort, dropX, dropY) {
  addNodeDialogSourcePort = sourcePort;
  addNodeDialogDropX = dropX;
  addNodeDialogDropY = dropY;
  const listEl = document.getElementById('add-node-dialog-list');
  const titleEl = document.getElementById('add-node-dialog-title');
  const hintEl = document.getElementById('add-node-dialog-hint');
  listEl.innerHTML = '';
  const isConnectMode = !!sourcePort;
  if (titleEl) titleEl.textContent = isConnectMode ? 'Add building and connect' : 'Add building';
  if (hintEl) hintEl.textContent = isConnectMode ? 'Choose a building to place at the drop location and connect from the previous node.' : 'Choose a building to place here.';
  const list = isConnectMode ? machinesList.filter(b => b.type !== 'miner') : machinesList;
  list.forEach(({ type, tierId, label, icon }) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'add-node-option';
    btn.dataset.type = type;
    btn.dataset.tier = tierId;
    btn.dataset.icon = icon;
    btn.innerHTML = `<span class="add-node-icon">${icon}</span><span>${label}</span>`;
    btn.addEventListener('click', () => {
      saveState();
      const node = createNode(type, addNodeDialogDropX - 80, addNodeDialogDropY - 45, icon, tierId);
      if (addNodeDialogSourcePort) {
        const srcNode = addNodeDialogSourcePort.closest('.node');
        if (srcNode) {
          if (addNodeDialogSourcePort.dataset.portType === 'output') {
            const toPort = node.querySelector('.port.input');
            if (toPort) {
              connections.push({
                fromNode: srcNode.dataset.id,
                fromPort: addNodeDialogSourcePort.className,
                toNode: node.dataset.id,
                toPort: toPort.className
              });
              drawConnection(addNodeDialogSourcePort, toPort);
            }
          } else {
            const fromPort = node.querySelector('.port.output');
            if (fromPort) {
              connections.push({
                fromNode: node.dataset.id,
                fromPort: fromPort.className,
                toNode: srcNode.dataset.id,
                toPort: addNodeDialogSourcePort.className
              });
              drawConnection(fromPort, addNodeDialogSourcePort);
            }
          }
        }
      }
      closeAddNodeDialog();
    });
    listEl.appendChild(btn);
  });
  document.getElementById('add-node-dialog-overlay').classList.add('show');
}

function closeAddNodeDialog() {
  document.getElementById('add-node-dialog-overlay').classList.remove('show');
  addNodeDialogSourcePort = null;
}

document.getElementById('add-node-dialog-cancel').onclick = closeAddNodeDialog;
document.getElementById('add-node-dialog-overlay').addEventListener('click', e => {
  if (e.target.id === 'add-node-dialog-overlay') closeAddNodeDialog();
});
document.getElementById('add-node-dialog-overlay').addEventListener('keydown', e => {
  if (e.key === 'Escape') closeAddNodeDialog();
});

function startConnectionDrag(sourcePort, e) {
  if (connectionDragSource) return;
  connectionDragSource = sourcePort;
  sourcePort.classList.add('active');
  document.body.style.cursor = 'crosshair';

  const p1 = getPortCenter(sourcePort);
  connectionPreviewLine = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  connectionPreviewLine.classList.add('connection-preview');
  connectionPreviewLine.setAttribute('d', `M${p1.x},${p1.y} L${p1.x},${p1.y}`);
  svg.appendChild(connectionPreviewLine);

  const onMove = e => {
    const p2 = getCanvasPoint(e.clientX, e.clientY);
    const dx = p2.x - p1.x;
    const curvature = 0.35;
    const hx1 = p1.x + dx * curvature;
    const hx2 = p2.x - dx * curvature;
    connectionPreviewLine.setAttribute('d', `M${p1.x},${p1.y} C${hx1},${p1.y} ${hx2},${p2.y} ${p2.x},${p2.y}`);
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const port = under && under.classList && under.classList.contains('port') ? under : under && under.closest('.port');
    if (connectionDropHighlight) {
      connectionDropHighlight.classList.remove('port-drop-target');
      connectionDropHighlight = null;
    }
    const sourceIsOutput = sourcePort.dataset.portType === 'output';
    const validDrop = port && port.closest('.node') !== sourcePort.closest('.node') &&
      (sourceIsOutput ? port.dataset.portType === 'input' : port.dataset.portType === 'output');
    if (validDrop) {
      port.classList.add('port-drop-target');
      connectionDropHighlight = port;
    }
  };
  const onUp = e => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.style.cursor = '';
    connectionDragSource.classList.remove('active');
    connectionDragSource = null;

    const sourceNode = sourcePort.closest('.node');
    let targetPort = connectionDropHighlight;
    if (!targetPort) {
      const under = document.elementFromPoint(e.clientX, e.clientY);
      targetPort = under && (under.classList.contains('port') ? under : under.closest('.port'));
    }
    if (connectionDropHighlight) {
      connectionDropHighlight.classList.remove('port-drop-target');
      connectionDropHighlight = null;
    }

    const sourceIsOutput = sourcePort.dataset.portType === 'output';
    const targetIsInput = targetPort && targetPort.dataset.portType === 'input';
    const targetIsOutput = targetPort && targetPort.dataset.portType === 'output';
    const canConnect = (sourceIsOutput && targetIsInput) || (sourceIsOutput === false && targetIsOutput);

    if (targetPort && canConnect) {
      const targetNode = targetPort.closest('.node');
      if (targetNode && targetNode !== sourceNode) {
        saveState();
        let fromNode, fromPort, toNode, toPort;
        if (sourceIsOutput) {
          fromNode = sourceNode.dataset.id;
          fromPort = sourcePort.className;
          toNode = targetNode.dataset.id;
          toPort = targetPort.className;
          drawConnection(sourcePort, targetPort);
        } else {
          fromNode = targetNode.dataset.id;
          fromPort = targetPort.className;
          toNode = sourceNode.dataset.id;
          toPort = sourcePort.className;
          drawConnection(targetPort, sourcePort);
        }
        connections.push({ fromNode, fromPort, toNode, toPort });
      } else if (targetNode === sourceNode) {
        toast('Cannot connect a node to itself');
      }
    } else if (!targetPort || !canConnect) {
      const dropPoint = getCanvasPoint(e.clientX, e.clientY);
      openAddNodeDialog(sourcePort, dropPoint.x, dropPoint.y);
    }

    if (connectionPreviewLine && connectionPreviewLine.parentNode) {
      connectionPreviewLine.parentNode.removeChild(connectionPreviewLine);
    }
    connectionPreviewLine = null;
  };

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// ─── Draw connection line ────────────────────────
function drawConnection(fromPort, toPort) {
  const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
  g.classList.add("connection-group");
  const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
  line.classList.add("connection");
  const labelBg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  labelBg.classList.add("connection-label-bg");
  const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
  label.classList.add("connection-label");
  g.appendChild(line);
  g.appendChild(labelBg);
  g.appendChild(label);
  svg.appendChild(g);

  updateLinePath(line, fromPort, toPort);
  line.dataset.fromNode = fromPort.closest('.node').dataset.id;
  line.dataset.toNode   = toPort.closest('.node').dataset.id;
  line.dataset.fromPortClass = fromPort.className;
  line.dataset.toPortClass   = toPort.className;
  updateAllLines();
  const toNode = toPort.closest('.node');
  if (toNode) updateNodeInputLabels(toNode);
}

function getPortCenter(port, canvasRect) {
  const rect = port.getBoundingClientRect();
  const cr = canvasRect || wrapper.getBoundingClientRect();
  return {
    x: (rect.left + rect.width / 2 - cr.left - translateX) / scale,
    y: (rect.top  + rect.height / 2 - cr.top  - translateY) / scale
  };
}

function updateLinePath(line, fromPort, toPort, canvasRect) {
  const p1 = getPortCenter(fromPort, canvasRect);
  const p2 = getPortCenter(toPort, canvasRect);
  const dx = p2.x - p1.x;
  const curvature = 0.35;
  const hx1 = p1.x + dx * curvature;
  const hx2 = p2.x - dx * curvature;
  line.setAttribute("d", `M${p1.x},${p1.y} C${hx1},${p1.y} ${hx2},${p2.y} ${p2.x},${p2.y}`);
}

function findPortByClass(node, portClass) {
  if (!node || !portClass) return null;
  const list = node.querySelectorAll('.port');
  for (const p of list) {
    if (p.className === portClass) return p;
  }
  return null;
}

function updateAllLines() {
  const onlyNodeId = pendingUpdateNodeId;
  pendingUpdateNodeId = null;

  const canvasRect = wrapper.getBoundingClientRect();
  const lines = svg.querySelectorAll('.connection');
  const toUpdate = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fromId = line.dataset.fromNode;
    const toId = line.dataset.toNode;
    if (onlyNodeId && fromId !== onlyNodeId && toId !== onlyNodeId) continue;

    const fromNode = nodeById.get(fromId);
    const toNode = nodeById.get(toId);
    if (!fromNode || !toNode) continue;

    const fromPort = line.dataset.fromPortClass
      ? findPortByClass(fromNode, line.dataset.fromPortClass)
      : fromNode.querySelector('.port.output');
    const toPort = line.dataset.toPortClass
      ? findPortByClass(toNode, line.dataset.toPortClass)
      : toNode.querySelector('.port.input');

    if (fromPort && toPort) {
      const p1 = getPortCenter(fromPort, canvasRect);
      const p2 = getPortCenter(toPort, canvasRect);
      const dx = p2.x - p1.x;
      const curvature = 0.35;
      toUpdate.push({ line, p1, p2, dx, curvature, fromNode });
    }
  }

  for (let i = 0; i < toUpdate.length; i++) {
    const { line, p1, p2, dx, curvature, fromNode } = toUpdate[i];
    const hx1 = p1.x + dx * curvature;
    const hx2 = p2.x - dx * curvature;
    line.setAttribute("d", `M${p1.x},${p1.y} C${hx1},${p1.y} ${hx2},${p2.y} ${p2.x},${p2.y}`);
    const group = line.closest('.connection-group');
    const labelEl = group ? group.querySelector('.connection-label') : null;
    const labelBgEl = group ? group.querySelector('.connection-label-bg') : null;
    if (labelEl && fromNode) {
      const item = fromNode.dataset.item || 'Item';
      let rate = parseFloat(fromNode.dataset.rate != null ? fromNode.dataset.rate : 0);
      if (fromNode.dataset.type === 'splitter') {
        const outCount = [...svg.querySelectorAll('.connection')].filter(l => l.dataset.fromNode === fromNode.dataset.id).length;
        if (outCount > 0) rate = rate / outCount;
      }
      labelEl.textContent = `${item} ${Number.isFinite(rate) ? rate : 0}/min`;
      const midX = (p1.x + 3 * hx1 + 3 * hx2 + p2.x) / 8;
      const midY = (p1.y + p2.y) / 2;
      labelEl.setAttribute('x', midX);
      labelEl.setAttribute('y', midY);
      if (labelBgEl) {
        const pad = 4;
        const rx = 4;
        try {
          const bbox = labelEl.getBBox();
          labelBgEl.setAttribute('x', bbox.x - pad);
          labelBgEl.setAttribute('y', bbox.y - pad);
          labelBgEl.setAttribute('width', bbox.width + pad * 2);
          labelBgEl.setAttribute('height', bbox.height + pad * 2);
          labelBgEl.setAttribute('rx', rx);
          labelBgEl.setAttribute('ry', rx);
        } catch (_) {}
      }
    }
  }
}

// ─── Calculation (multi-input + toast) ───────────
function getIncomingByPort(nodeId) {
  const list = connections.filter(c => c.toNode === nodeId);
  list.sort((a, b) => (a.toPort || '').localeCompare(b.toPort || ''));
  return list;
}

function getOutgoingConnections(nodeId) {
  return connections.filter(c => c.fromNode === nodeId);
}

function getRequiredInputFromPort(downstreamNode, toPortClass) {
  const type = downstreamNode.dataset.type;
  const rate = parseFloat(downstreamNode.dataset.rate || 0);
  if (rate <= 0) return 0;
  if (type === 'splitter') {
    return rate;
  }
  if (type === 'merger') return 0;
  const recipe = getRecipeForNode(downstreamNode);
  if (!recipe || !recipe.out || recipe.out <= 0) return 0;
  const match = (toPortClass || '').match(/input-(\d+)/);
  const index = match ? parseInt(match[1], 10) - 1 : 0;
  const inRates = [recipe.in, recipe.in2, recipe.in3, recipe.in4];
  const inRate = inRates[index];
  if (inRate == null) return 0;
  return (rate / recipe.out) * inRate;
}

function runBackwardPass() {
  const sinks = nodes.filter(n => !getOutgoingConnections(n.dataset.id).length);
  const order = [];
  const seen = new Set();
  let queue = [...sinks];
  while (queue.length) {
    const n = queue.shift();
    if (seen.has(n.dataset.id)) continue;
    seen.add(n.dataset.id);
    order.push(n);
    const incoming = getIncomingByPort(n.dataset.id);
    incoming.forEach(c => {
      const fromNode = nodeById.get(c.fromNode);
      if (fromNode && !seen.has(fromNode.dataset.id)) queue.push(fromNode);
    });
  }
  order.forEach(downstreamNode => {
    const rate = parseFloat(downstreamNode.dataset.rate || 0);
    if (rate <= 0) return;
    const incoming = getIncomingByPort(downstreamNode.dataset.id);
    incoming.forEach(c => {
      const fromNode = nodeById.get(c.fromNode);
      if (!fromNode) return;
      const required = getRequiredInputFromPort(downstreamNode, c.toPort);
      if (required <= 0) return;
      let newRate = Math.max(parseFloat(fromNode.dataset.rate || 0), required);
      if (hasCalculatedRate(fromNode.dataset.type)) {
        const maxOut = fromNode.dataset.type === 'miner'
          ? getMinerCalculatedRate(fromNode.dataset.tier || 'mk1', fromNode.dataset.oreQuality)
          : getCraftingMachineCalculatedRate(fromNode.dataset.type, fromNode.dataset.tier || 'mk1', fromNode.dataset.item);
        newRate = Math.min(newRate, maxOut);
      }
      fromNode.dataset.rate = String(newRate);
      const rateEl = fromNode.querySelector('.node-rate');
      if (rateEl) rateEl.value = String(newRate);
    });
  });
}

document.getElementById('calc-btn').onclick = () => {
  nodes.forEach(n => {
    n.dataset.rate = '0';
    const rateEl = n.querySelector('.node-rate');
    if (rateEl) rateEl.value = '0';
  });

  const incoming = new Set(connections.map(c => c.toNode));
  const sources = nodes.filter(n => !incoming.has(n.dataset.id));

  sources.forEach(n => {
    const r = getRecipeForNode(n);
    if (r) {
      n.dataset.rate = String(r.out);
      const rateEl = n.querySelector('.node-rate');
      if (rateEl) rateEl.value = String(r.out);
    }
  });

  let updated = true;
  let safety = 0;
  while (updated && safety++ < 50) {
    updated = false;
    nodes.forEach(node => {
      if (parseFloat(node.dataset.rate) > 0) return;
      const ins = getIncomingByPort(node.dataset.id);
      const type = node.dataset.type;

      if (type === 'splitter') {
        if (ins.length !== 1) return;
        const src = nodes.find(n => n.dataset.id === ins[0].fromNode);
        const inRate = parseFloat(src?.dataset?.rate || 0);
        if (inRate <= 0) return;
        node.dataset.rate = String(inRate);
        node.dataset.item = src?.dataset?.item || 'Item';
        updated = true;
        return;
      }
      if (type === 'merger') {
        if (ins.length === 0) return;
        const inputs = ins.map(c => {
          const src = nodes.find(n => n.dataset.id === c.fromNode);
          return parseFloat(src?.dataset?.rate || 0);
        });
        const total = inputs.reduce((a, b) => a + b, 0);
        if (total <= 0) return;
        const firstSrc = nodes.find(n => n.dataset.id === ins[0].fromNode);
        node.dataset.rate = String(total);
        node.dataset.item = firstSrc?.dataset?.item || 'Item';
        updated = true;
        return;
      }

      if (ins.length === 0) return;
      const recipe = getRecipeForNode(node);
      if (!recipe) return;

      const inputs = ins.map(c => {
        const src = nodes.find(n => n.dataset.id === c.fromNode);
        return parseFloat(src?.dataset?.rate || 0);
      });
      const inKeys = ['in', 'in2', 'in3', 'in4'].filter(k => recipe[k] != null);
      let eff = 1;
      if (inKeys.length > 0) {
        eff = Math.min(...inKeys.map((k, i) => {
          const need = recipe[k];
          const avail = inputs[i] ?? 0;
          return need > 0 ? avail / need : 1;
        }));
      }
      const produced = eff * recipe.out;

      node.dataset.rate = String(produced);
      const rateEl = node.querySelector('.node-rate');
      if (rateEl) rateEl.value = produced.toFixed(1);
      updated = true;
    });
  }

  const sinks = nodes.filter(n => !getOutgoingConnections(n.dataset.id).length);
  sinks.forEach(n => {
    if (parseFloat(n.dataset.rate || 0) > 0) return;
    const recipe = getRecipeForNode(n);
    if (recipe && recipe.out) {
      n.dataset.rate = String(recipe.out);
      const rateEl = n.querySelector('.node-rate');
      if (rateEl) rateEl.value = String(recipe.out);
    }
  });

  runBackwardPass();

  updated = true;
  safety = 0;
  while (updated && safety++ < 50) {
    updated = false;
    nodes.forEach(node => {
      const ins = getIncomingByPort(node.dataset.id);
      if (ins.length === 0) return;
      const type = node.dataset.type;
      if (type === 'splitter') {
        if (ins.length !== 1) return;
        const src = nodes.find(n => n.dataset.id === ins[0].fromNode);
        const inRate = parseFloat(src?.dataset?.rate || 0);
        if (inRate <= 0) return;
        const prev = parseFloat(node.dataset.rate || 0);
        if (Math.abs(inRate - prev) < 1e-6) return;
        node.dataset.rate = String(inRate);
        node.dataset.item = src?.dataset?.item || 'Item';
        const rateEl = node.querySelector('.node-rate');
        if (rateEl) rateEl.value = String(inRate);
        updated = true;
        return;
      }
      if (type === 'merger') {
        const inputs = ins.map(c => {
          const src = nodes.find(n => n.dataset.id === c.fromNode);
          return parseFloat(src?.dataset?.rate || 0);
        });
        const total = inputs.reduce((a, b) => a + b, 0);
        const prev = parseFloat(node.dataset.rate || 0);
        if (Math.abs(total - prev) < 1e-6) return;
        const firstSrc = nodes.find(n => n.dataset.id === ins[0].fromNode);
        node.dataset.rate = String(total);
        node.dataset.item = firstSrc?.dataset?.item || 'Item';
        const rateEl = node.querySelector('.node-rate');
        if (rateEl) rateEl.value = String(total);
        updated = true;
        return;
      }
      const recipe = getRecipeForNode(node);
      if (!recipe) return;
      const inputs = ins.map(c => {
        const src = nodes.find(n => n.dataset.id === c.fromNode);
        return parseFloat(src?.dataset?.rate || 0);
      });
      const inKeys = ['in', 'in2', 'in3', 'in4'].filter(k => recipe[k] != null);
      let eff = 1;
      if (inKeys.length > 0) {
        eff = Math.min(...inKeys.map((k, i) => {
          const need = recipe[k];
          const avail = inputs[i] ?? 0;
          return need > 0 ? avail / need : 1;
        }));
      }
      const produced = eff * recipe.out;
      const prev = parseFloat(node.dataset.rate || 0);
      if (Math.abs(produced - prev) < 1e-6) return;
      node.dataset.rate = String(produced);
      const rateEl = node.querySelector('.node-rate');
      if (rateEl) rateEl.value = produced.toFixed(1);
      updated = true;
    });
  }

  nodes.forEach(n => updateNodeInputLabels(n));

  if (safety >= 50) toast('Possible loop or complex graph', true);
  else toast('Rates calculated');
};

// ─── Export ──────────────────────────────────────
document.getElementById('export-btn').onclick = () => {
  const data = {
    nodes: nodes.map(n => ({
      id: n.dataset.id,
      type: n.dataset.type,
      tier: n.dataset.tier,
      x: parseFloat(n.style.left),
      y: parseFloat(n.style.top),
      rate: n.dataset.rate,
      item: n.dataset.item,
      name: n.querySelector('.node-header')?.textContent?.trim(),
      ...(n.dataset.miningRate && { miningRate: n.dataset.miningRate }),
      ...(n.dataset.oreQuality && { oreQuality: n.dataset.oreQuality })
    })),
    connections: connections.map(c => ({ ...c })),
    nodeCounter
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'satisfactory-flow.json';
  a.click();
  URL.revokeObjectURL(url);
};

// ─── Import ──────────────────────────────────────
document.getElementById('import-btn').onclick = () => document.getElementById('import-file-input').click();
document.getElementById('import-file-input').addEventListener('change', e => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data.nodes || !Array.isArray(data.nodes)) { toast('Invalid file: missing nodes', true); return; }
      saveState();
      nodes.forEach(n => n.remove());
      nodes = [];
      nodeById.clear();
      connections = [];
      const maxId = data.nodes.reduce((m, nd) => Math.max(m, Number(nd.id) || 0), 0);
      nodeCounter = (data.nodeCounter != null ? data.nodeCounter : maxId + 1);
      data.nodes.forEach(nd => {
        const node = createNodeFromData({
          ...nd,
          id: nd.id != null ? nd.id : nodeCounter++,
          name: nd.name || nd.label
        });
        nodes.push(node);
        nodeById.set(node.dataset.id, node);
      });
      (data.connections || []).forEach(c => {
        const fromNode = nodes.find(n => n.dataset.id === String(c.fromNode));
        const toNode = nodes.find(n => n.dataset.id === String(c.toNode));
        if (!fromNode || !toNode) return;
        const fromPort = findPortByClass(fromNode, c.fromPort) || fromNode.querySelector('.port.output');
        const toPort = findPortByClass(toNode, c.toPort) || toNode.querySelector('.port.input');
        if (fromPort && toPort) {
          connections.push({
            fromNode: fromNode.dataset.id,
            fromPort: fromPort.className,
            toNode: toNode.dataset.id,
            toPort: toPort.className
          });
          drawConnection(fromPort, toPort);
        }
      });
      updateAllLines();
      nodes.forEach(n => updateNodeInputLabels(n));
      toast('Flow imported');
    } catch (err) {
      toast('Invalid JSON: ' + (err.message || 'parse error'), true);
    }
  };
  reader.readAsText(file);
});

// ─── Edit dialog ──────────────────────────────────
const editOverlay = document.getElementById('edit-dialog-overlay');
const editNameInput = document.getElementById('edit-dialog-name');
const editProductionSelect = document.getElementById('edit-dialog-production');
const editRecipeInputsEl = document.getElementById('edit-dialog-recipe-inputs');
const editRateInput = document.getElementById('edit-dialog-rate');
const editOreQualityWrap = document.getElementById('edit-dialog-ore-quality-wrap');
const editOreQualitySelect = document.getElementById('edit-dialog-ore-quality');
let editDialogNode = null;

function updateEditDialogRecipeInputs() {
  if (!editRecipeInputsEl) return;
  if (!editDialogNode) {
    editRecipeInputsEl.textContent = '';
    return;
  }
  const type = editDialogNode.dataset.type;
  const item = editProductionSelect?.value;
  const opts = recipeListByMachine[type] || [];
  const recipe = opts.find(r => (r.item || r.name) === item) || opts[0];
  if (!recipe || !recipe.inputs?.length) {
    editRecipeInputsEl.textContent = '';
    return;
  }
  const rates = [recipe.in, recipe.in2, recipe.in3, recipe.in4].filter(n => n != null && n > 0);
  const parts = (recipe.inputs || []).slice(0, 4).map((inp, i) => {
    const perMin = rates[i] != null ? Math.round(rates[i] * 10) / 10 : '';
    return perMin ? `${perMin}/min ${inp.item}` : null;
  }).filter(Boolean);
  editRecipeInputsEl.textContent = parts.length ? parts.join(', ') : '';
}

function openEditDialog(node) {
  editDialogNode = node;
  editNameInput.value = node.querySelector('.node-header').textContent.trim();

  const type = node.dataset.type;
  if (hasCalculatedRate(type)) {
    const rate = type === 'miner'
      ? getMinerCalculatedRate(node.dataset.tier || 'mk1', node.dataset.oreQuality)
      : getCraftingMachineCalculatedRate(type, node.dataset.tier || 'mk1', node.dataset.item);
    editRateInput.value = String(rate);
    editRateInput.readOnly = true;
  } else {
    editRateInput.value = node.dataset.rate ?? node.querySelector('.node-rate')?.value ?? '0';
    editRateInput.readOnly = false;
  }

  const opts = recipeListByMachine[type] || [];
  editProductionSelect.innerHTML = '';
  opts.forEach(r => {
    const opt = document.createElement('option');
    const val = r.item || r.name;
    opt.value = val;
    opt.textContent = val;
    editProductionSelect.appendChild(opt);
  });
  editProductionSelect.value = node.dataset.item || (opts[0] && (opts[0].item || opts[0].name)) || '';
  updateEditDialogRecipeInputs();

  if (type === 'smelter') {
    editProductionSelect._smelterRateUpdater = () => {
      if (editDialogNode && editDialogNode.dataset.type === 'smelter') {
        const rate = getCraftingMachineCalculatedRate('smelter', editDialogNode.dataset.tier || 'mk1', editProductionSelect.value);
        editRateInput.value = String(rate);
      }
      updateEditDialogRecipeInputs();
    };
    editProductionSelect.addEventListener('change', editProductionSelect._smelterRateUpdater);
  } else {
    if (editProductionSelect._smelterRateUpdater) {
      editProductionSelect.removeEventListener('change', editProductionSelect._smelterRateUpdater);
      editProductionSelect._smelterRateUpdater = null;
    }
    if (opts.length > 0) {
      editProductionSelect._recipeInputsUpdater = () => updateEditDialogRecipeInputs();
      editProductionSelect.addEventListener('change', editProductionSelect._recipeInputsUpdater);
    }
  }

  if (editOreQualityWrap && editOreQualitySelect) {
    if (type === 'miner') {
      editOreQualityWrap.style.display = '';
      editOreQualitySelect.innerHTML = '';
      getMinerOreQualities().forEach(q => {
        const opt = document.createElement('option');
        opt.value = q.id;
        opt.textContent = q.name;
        editOreQualitySelect.appendChild(opt);
      });
      editOreQualitySelect.value = node.dataset.oreQuality || getMinerDefaultOreQualityId();
    } else {
      editOreQualityWrap.style.display = 'none';
    }
  }

  editOverlay.classList.add('show');
  editNameInput.focus();
  editNameInput.select();

  const focusables = [...editOverlay.querySelectorAll('button, input, select')].filter(el => el.offsetParent != null);
  editOverlay._focusTrap = e => {
    if (e.key !== 'Tab') return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus(); }
    } else {
      if (document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  editOverlay.addEventListener('keydown', editOverlay._focusTrap);
}

function closeEditDialog() {
  editOverlay.classList.remove('show');
  editOverlay.removeEventListener('keydown', editOverlay._focusTrap);
  if (editProductionSelect._smelterRateUpdater) {
    editProductionSelect.removeEventListener('change', editProductionSelect._smelterRateUpdater);
    editProductionSelect._smelterRateUpdater = null;
  }
  if (editProductionSelect._recipeInputsUpdater) {
    editProductionSelect.removeEventListener('change', editProductionSelect._recipeInputsUpdater);
    editProductionSelect._recipeInputsUpdater = null;
  }
  editDialogNode = null;
}

function saveEditDialog() {
  if (!editDialogNode) return;
  const node = editDialogNode;
  const name = editNameInput.value.trim();
  if (name) node.querySelector('.node-header').textContent = name;
  const item = editProductionSelect.value;
  if (item) node.dataset.item = item;
  const productEl = node.querySelector('.node-product');
  if (productEl) productEl.textContent = node.dataset.item || '';
  if (hasCalculatedRate(node.dataset.type)) {
    if (node.dataset.type === 'miner' && editOreQualitySelect) {
      const qualityId = editOreQualitySelect.value;
      if (qualityId) node.dataset.oreQuality = qualityId;
    }
    const rate = node.dataset.type === 'miner'
      ? getMinerCalculatedRate(node.dataset.tier || 'mk1', node.dataset.oreQuality)
      : getCraftingMachineCalculatedRate(node.dataset.type, node.dataset.tier || 'mk1', node.dataset.item);
    node.dataset.rate = String(rate);
    if (node.dataset.type === 'miner') node.dataset.miningRate = String(rate);
    const rateEl = node.querySelector('.node-rate');
    if (rateEl) rateEl.value = String(rate);
  } else {
    const rateStr = String(editRateInput.value).trim().replace(',', '.');
    const rateNum = parseFloat(rateStr);
    if (rateStr !== '' && !isNaN(rateNum) && rateNum >= 0) {
      node.dataset.rate = String(rateNum);
      const rateEl = node.querySelector('.node-rate');
      if (rateEl) rateEl.value = String(rateNum);
    }
  }
  updateNodeInputLabels(node);
  closeEditDialog();
}

editOverlay.addEventListener('click', e => {
  if (e.target === editOverlay) closeEditDialog();
});
editNameInput.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeEditDialog();
  if (e.key === 'Enter') saveEditDialog();
});
document.getElementById('edit-dialog-cancel').onclick = closeEditDialog;
document.getElementById('edit-dialog-save').onclick = saveEditDialog;

function editNode(node) {
  openEditDialog(node);
}

// ─── Node context menu ────────────────────────────
const ctxMenu = document.getElementById('node-context-menu');
let ctxMenuNode = null;

function removeConnection(fromNodeId, toNodeId, toPortClass) {
  const idx = connections.findIndex(c => c.fromNode === fromNodeId && c.toNode === toNodeId && (c.toPort === toPortClass || (!toPortClass && !c.toPort)));
  if (idx !== -1) connections.splice(idx, 1);
  const line = [...svg.querySelectorAll('.connection')].find(l =>
    l.dataset.fromNode === fromNodeId && l.dataset.toNode === toNodeId && (!toPortClass || l.dataset.toPortClass === toPortClass));
  if (line) {
    const group = line.closest('.connection-group');
    (group || line).remove();
  }
  const toNode = nodeById.get(toNodeId);
  if (toNode) updateNodeInputLabels(toNode);
}

function showNodeContextMenu(e, node) {
  e.preventDefault();
  e.stopPropagation();
  ctxMenuNode = node;
  ctxMenu.style.left = e.clientX + 'px';
  ctxMenu.style.top = e.clientY + 'px';

  const outConnections = connections.filter(c => c.fromNode === node.dataset.id);
  const inConnections = connections.filter(c => c.toNode === node.dataset.id);
  const existing = ctxMenu.querySelectorAll('.ctx-item.unlink, .ctx-divider, .ctx-sub');
  existing.forEach(el => el.remove());

  if (outConnections.length + inConnections.length > 0) {
    const divider = document.createElement('div');
    divider.className = 'ctx-divider';
    ctxMenu.appendChild(divider);
    const sub = document.createElement('div');
    sub.className = 'ctx-sub';
    sub.textContent = 'Unlink';
    ctxMenu.appendChild(sub);
    outConnections.forEach(c => {
      const toNode = nodes.find(n => n.dataset.id === c.toNode);
      const label = toNode ? (toNode.querySelector('.node-header')?.textContent?.trim() || 'Node') : 'Node';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ctx-item unlink';
      btn.textContent = `Out → ${label}`;
      btn.dataset.fromNode = c.fromNode;
      btn.dataset.toNode = c.toNode;
      btn.dataset.toPort = c.toPort || '';
      btn.addEventListener('click', ev => {
        ev.stopPropagation();
        saveState();
        removeConnection(c.fromNode, c.toNode, c.toPort);
        closeContextMenu();
      });
      ctxMenu.appendChild(btn);
    });
    inConnections.forEach(c => {
      const fromNode = nodes.find(n => n.dataset.id === c.fromNode);
      const label = fromNode ? (fromNode.querySelector('.node-header')?.textContent?.trim() || 'Node') : 'Node';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ctx-item unlink';
      btn.textContent = `In ← ${label}`;
      btn.dataset.fromNode = c.fromNode;
      btn.dataset.toNode = c.toNode;
      btn.dataset.toPort = c.toPort || '';
      btn.addEventListener('click', ev => {
        ev.stopPropagation();
        saveState();
        removeConnection(c.fromNode, c.toNode, c.toPort);
        closeContextMenu();
      });
      ctxMenu.appendChild(btn);
    });
  }

  ctxMenu.classList.add('show');
  setTimeout(() => document.addEventListener('click', closeContextMenu), 0);
}

function closeContextMenu() {
  ctxMenu.classList.remove('show');
  document.removeEventListener('click', closeContextMenu);
  ctxMenuNode = null;
}

function clearConnectionsForNode(node) {
  const id = node.dataset.id;
  connections = connections.filter(c => c.fromNode !== id && c.toNode !== id);
  svg.querySelectorAll('.connection').forEach(line => {
    if (line.dataset.fromNode === id || line.dataset.toNode === id) {
      const group = line.closest('.connection-group');
      (group || line).remove();
    }
  });
}

function deleteNode(node) {
  clearConnectionsForNode(node);
  nodeById.delete(node.dataset.id);
  const i = nodes.indexOf(node);
  if (i !== -1) nodes.splice(i, 1);
  node.remove();
}

ctxMenu.querySelectorAll('.ctx-item[data-action]').forEach(btn => {
  btn.addEventListener('click', e => {
    e.stopPropagation();
    if (!ctxMenuNode) return;
    const action = btn.dataset.action;
    if (action === 'edit') editNode(ctxMenuNode);
    else if (action === 'clear') { saveState(); clearConnectionsForNode(ctxMenuNode); }
    else if (action === 'delete') { saveState(); deleteNode(ctxMenuNode); }
    closeContextMenu();
  });
});

// ─── Load config and init ────────────────────────
// Inline default config so the app works when opened as file:// (fetch is blocked)
const DEFAULT_CONFIG = {"machines":{"miner":{"name":"Miner","inputCount":0,"outputCount":1,"oreQualities":[{"id":"impure","name":"Impure","multiplier":0.5},{"id":"normal","name":"Normal","multiplier":1},{"id":"pure","name":"Pure","multiplier":2}],"tiers":[{"id":"mk1","name":"Mk.1","miningSpeed":0.5,"maxOutputPerMin":60},{"id":"mk2","name":"Mk.2","miningSpeed":1,"maxOutputPerMin":120},{"id":"mk3","name":"Mk.3","miningSpeed":2,"maxOutputPerMin":240}]},"smelter":{"name":"Smelter","inputCount":1,"outputCount":1,"tiers":[{"id":"mk1","name":"Mk.1","craftingSpeed":1},{"id":"mk2","name":"Mk.2","craftingSpeed":2},{"id":"mk3","name":"Mk.3","craftingSpeed":4}]},"constructor":{"name":"Constructor","inputCount":2,"outputCount":1,"tiers":[{"id":"mk1","name":"Mk.1","craftingSpeed":1},{"id":"mk2","name":"Mk.2","craftingSpeed":2},{"id":"mk3","name":"Mk.3","craftingSpeed":4}]},"assembler":{"name":"Assembler","inputCount":2,"outputCount":1,"tiers":[{"id":"mk1","name":"Mk.1","craftingSpeed":1},{"id":"mk2","name":"Mk.2","craftingSpeed":2},{"id":"mk3","name":"Mk.3","craftingSpeed":4}]},"foundry":{"name":"Foundry","inputCount":2,"outputCount":1,"tiers":[{"id":"mk1","name":"Mk.1","craftingSpeed":1},{"id":"mk2","name":"Mk.2","craftingSpeed":2},{"id":"mk3","name":"Mk.3","craftingSpeed":4}]},"refinery":{"name":"Refinery","inputCount":3,"outputCount":1,"tiers":[{"id":"mk1","name":"Mk.1","craftingSpeed":1},{"id":"mk2","name":"Mk.2","craftingSpeed":2},{"id":"mk3","name":"Mk.3","craftingSpeed":4}]},"storage_container":{"name":"Storage Container","inputCount":1,"outputCount":1,"slots":24,"maxItems":12000,"tiers":[{"id":"mk1","name":"Mk.1"}]},"splitter":{"name":"Splitter","inputCount":1,"outputCount":3,"tiers":[{"id":"mk1","name":"Mk.1","maxFlowPerMin":60},{"id":"mk2","name":"Mk.2","maxFlowPerMin":120},{"id":"mk3","name":"Mk.3","maxFlowPerMin":270},{"id":"mk4","name":"Mk.4","maxFlowPerMin":480},{"id":"mk5","name":"Mk.5","maxFlowPerMin":780},{"id":"mk6","name":"Mk.6","maxFlowPerMin":1200}]},"merger":{"name":"Merger","inputCount":3,"outputCount":1,"tiers":[{"id":"mk1","name":"Mk.1","maxFlowPerMin":60},{"id":"mk2","name":"Mk.2","maxFlowPerMin":120},{"id":"mk3","name":"Mk.3","maxFlowPerMin":270},{"id":"mk4","name":"Mk.4","maxFlowPerMin":480},{"id":"mk5","name":"Mk.5","maxFlowPerMin":780},{"id":"mk6","name":"Mk.6","maxFlowPerMin":1200}]}},"items":[{"id":"iron_ore","name":"Iron Ore"},{"id":"copper_ore","name":"Copper Ore"},{"id":"limestone","name":"Limestone"},{"id":"coal","name":"Coal"},{"id":"caterium_ore","name":"Caterium Ore"},{"id":"iron_ingot","name":"Iron Ingot"},{"id":"copper_ingot","name":"Copper Ingot"},{"id":"caterium_ingot","name":"Caterium Ingot"},{"id":"iron_plate","name":"Iron Plate"},{"id":"iron_rod","name":"Iron Rod"},{"id":"screw","name":"Screw"},{"id":"concrete","name":"Concrete"},{"id":"copper_sheet","name":"Copper Sheet"},{"id":"reinforced_iron_plate","name":"Reinforced Iron Plate"},{"id":"modular_frame","name":"Modular Frame"},{"id":"rotor","name":"Rotor"},{"id":"smart_plating","name":"Smart Plating"},{"id":"cable","name":"Cable"},{"id":"steel_ingot","name":"Steel Ingot"},{"id":"steel_beam","name":"Steel Beam"},{"id":"steel_pipe","name":"Steel Pipe"},{"id":"quickwire","name":"Quickwire"},{"id":"solid_steel_ingot","name":"Solid Steel Ingot"},{"id":"plastic","name":"Plastic"},{"id":"rubber","name":"Rubber"},{"id":"fuel","name":"Fuel"},{"id":"wire","name":"Wire"},{"id":"crude_oil","name":"Crude Oil"},{"id":"water","name":"Water"}],"recipes":[{"id":"buffer","name":"Buffer","machine":"storage_container","craftingTimeSeconds":1,"inputs":[{"item":"Any","amount":1}],"outputs":[{"item":"Any","amount":1}]},{"id":"iron_ore","name":"Iron Ore","machine":"miner","craftingTimeSeconds":1,"inputs":[],"outputs":[{"item":"Iron Ore","amount":60}]},{"id":"copper_ore","name":"Copper Ore","machine":"miner","craftingTimeSeconds":1,"inputs":[],"outputs":[{"item":"Copper Ore","amount":60}]},{"id":"limestone","name":"Limestone","machine":"miner","craftingTimeSeconds":1,"inputs":[],"outputs":[{"item":"Limestone","amount":60}]},{"id":"coal","name":"Coal","machine":"miner","craftingTimeSeconds":1,"inputs":[],"outputs":[{"item":"Coal","amount":60}]},{"id":"caterium_ore","name":"Caterium Ore","machine":"miner","craftingTimeSeconds":1,"inputs":[],"outputs":[{"item":"Caterium Ore","amount":60}]},{"id":"iron_ingot","name":"Iron Ingot","machine":"smelter","craftingTimeSeconds":2,"inputs":[{"item":"Iron Ore","amount":1}],"outputs":[{"item":"Iron Ingot","amount":1}]},{"id":"copper_ingot","name":"Copper Ingot","machine":"smelter","craftingTimeSeconds":2,"inputs":[{"item":"Copper Ore","amount":1}],"outputs":[{"item":"Copper Ingot","amount":1}]},{"id":"caterium_ingot","name":"Caterium Ingot","machine":"smelter","craftingTimeSeconds":4,"inputs":[{"item":"Caterium Ore","amount":3}],"outputs":[{"item":"Caterium Ingot","amount":1}]},{"id":"iron_plate","name":"Iron Plate","machine":"constructor","craftingTimeSeconds":6,"inputs":[{"item":"Iron Ingot","amount":3}],"outputs":[{"item":"Iron Plate","amount":2}]},{"id":"iron_rod","name":"Iron Rod","machine":"constructor","craftingTimeSeconds":4,"inputs":[{"item":"Iron Ingot","amount":1}],"outputs":[{"item":"Iron Rod","amount":1}]},{"id":"screw","name":"Screw","machine":"constructor","craftingTimeSeconds":6,"inputs":[{"item":"Iron Rod","amount":1}],"outputs":[{"item":"Screw","amount":4}]},{"id":"concrete","name":"Concrete","machine":"constructor","craftingTimeSeconds":4,"inputs":[{"item":"Limestone","amount":3}],"outputs":[{"item":"Concrete","amount":1}]},{"id":"copper_sheet","name":"Copper Sheet","machine":"constructor","craftingTimeSeconds":6,"inputs":[{"item":"Copper Ingot","amount":2}],"outputs":[{"item":"Copper Sheet","amount":1}]},{"id":"wire","name":"Wire","machine":"constructor","craftingTimeSeconds":4,"inputs":[{"item":"Copper Ingot","amount":1}],"outputs":[{"item":"Wire","amount":2}]},{"id":"cable_constructor","name":"Cable","machine":"constructor","craftingTimeSeconds":2,"inputs":[{"item":"Wire","amount":2}],"outputs":[{"item":"Cable","amount":1}]},{"id":"steel_beam","name":"Steel Beam","machine":"constructor","craftingTimeSeconds":4,"inputs":[{"item":"Steel Ingot","amount":4}],"outputs":[{"item":"Steel Beam","amount":1}]},{"id":"steel_pipe","name":"Steel Pipe","machine":"constructor","craftingTimeSeconds":6,"inputs":[{"item":"Steel Ingot","amount":3}],"outputs":[{"item":"Steel Pipe","amount":2}]},{"id":"quickwire","name":"Quickwire","machine":"constructor","craftingTimeSeconds":5,"inputs":[{"item":"Caterium Ingot","amount":1}],"outputs":[{"item":"Quickwire","amount":5}]},{"id":"reinforced_iron_plate","name":"Reinforced Iron Plate","machine":"assembler","craftingTimeSeconds":12,"inputs":[{"item":"Iron Plate","amount":4},{"item":"Screw","amount":8}],"outputs":[{"item":"Reinforced Iron Plate","amount":1}]},{"id":"modular_frame","name":"Modular Frame","machine":"assembler","craftingTimeSeconds":15,"inputs":[{"item":"Reinforced Iron Plate","amount":4},{"item":"Iron Rod","amount":2}],"outputs":[{"item":"Modular Frame","amount":1}]},{"id":"rotor","name":"Rotor","machine":"assembler","craftingTimeSeconds":15,"inputs":[{"item":"Iron Rod","amount":3},{"item":"Screw","amount":6}],"outputs":[{"item":"Rotor","amount":1}]},{"id":"smart_plating","name":"Smart Plating","machine":"assembler","craftingTimeSeconds":30,"inputs":[{"item":"Reinforced Iron Plate","amount":2},{"item":"Rotor","amount":2}],"outputs":[{"item":"Smart Plating","amount":1}]},{"id":"cable","name":"Cable","machine":"assembler","craftingTimeSeconds":2,"inputs":[{"item":"Copper Ingot","amount":2},{"item":"Wire","amount":2}],"outputs":[{"item":"Cable","amount":2}]},{"id":"steel_ingot","name":"Steel Ingot","machine":"foundry","craftingTimeSeconds":3,"inputs":[{"item":"Iron Ore","amount":45},{"item":"Coal","amount":45}],"outputs":[{"item":"Steel Ingot","amount":45}]},{"id":"solid_steel_ingot","name":"Solid Steel Ingot","machine":"foundry","craftingTimeSeconds":3,"inputs":[{"item":"Iron Ingot","amount":20},{"item":"Coal","amount":20}],"outputs":[{"item":"Solid Steel Ingot","amount":60}]},{"id":"plastic","name":"Plastic","machine":"refinery","craftingTimeSeconds":6,"inputs":[{"item":"Crude Oil","amount":30},{"item":"Fuel","amount":20}],"outputs":[{"item":"Plastic","amount":20}]},{"id":"rubber","name":"Rubber","machine":"refinery","craftingTimeSeconds":6,"inputs":[{"item":"Crude Oil","amount":30},{"item":"Fuel","amount":20}],"outputs":[{"item":"Rubber","amount":20}]},{"id":"fuel","name":"Fuel","machine":"refinery","craftingTimeSeconds":6,"inputs":[{"item":"Crude Oil","amount":60},{"item":"Water","amount":40}],"outputs":[{"item":"Fuel","amount":40}]}]};

function init() {
  setupCanvasContextMenu();
}

function loadConfigAndInit() {
  APP_CONFIG = DEFAULT_CONFIG;
  buildConfigLookups();
  init();
}

fetch('config.json')
  .then(r => { if (!r.ok) throw new Error(r.statusText); return r.json(); })
  .then(config => {
    APP_CONFIG = config;
    buildConfigLookups();
    init();
  })
  .catch(() => {
    loadConfigAndInit();
  });
