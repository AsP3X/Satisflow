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
      x: parseFloat(n.style.left),
      y: parseFloat(n.style.top),
      rate: n.dataset.rate,
      item: n.dataset.item,
      miningRate: n.dataset.miningRate,
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
}
function createNodeFromData(nd) {
  const type = nd.type || 'miner';
  const node = document.createElement('div');
  node.className = 'node';
  node.style.left = (nd.x || 0) + 'px';
  node.style.top = (nd.y || 0) + 'px';
  node.dataset.id = String(nd.id);
  node.dataset.type = type;
  node.dataset.rate = nd.rate || '0';
  node.dataset.item = nd.item || getDefaultItem(type);
  if (type === 'miner') node.dataset.miningRate = nd.miningRate || '60';
  const icon = { miner: '⛏️', smelter: '♨️', constructor: '🔩', assembler: '⚙️', foundry: '🏭', refinery: '🛢️' }[type] || '';
  node.innerHTML = `
    <div class="node-header">${nd.name || icon + ' ' + (type.charAt(0).toUpperCase() + type.slice(1))}</div>
    <div class="node-rate-wrap"><input type="text" inputmode="decimal" class="node-rate" value="${nd.rate != null ? nd.rate : '0'}" /><span class="node-rate-unit">/ min</span></div>
  `;
  node.querySelector('.node-rate').addEventListener('input', e => {
    node.dataset.rate = e.target.value.replace(',', '.');
  });
  node.querySelector('.node-rate').addEventListener('change', e => {
    const v = parseFloat(String(e.target.value).replace(',', '.'));
    if (!isNaN(v) && v >= 0) node.dataset.rate = String(v);
    e.target.value = node.dataset.rate;
  });
  const portsContainer = document.createElement('div');
  portsContainer.style.cssText = 'position:absolute;inset:0;pointer-events:auto';
  const outPort = createPort('output', 'output');
  portsContainer.appendChild(outPort);
  if (type !== 'miner') {
    const inputCount = type === 'smelter' ? 1 : type === 'constructor' ? 2 : type === 'assembler' ? 4 : type === 'foundry' ? 2 : 3;
    for (let i = 1; i <= inputCount; i++) portsContainer.appendChild(createPort('input', 'input-' + i));
  }
  node.appendChild(portsContainer);
  canvas.appendChild(node);
  makeDraggable(node);
  node.addEventListener('dblclick', () => editNode(node));
  node.addEventListener('contextmenu', e => showNodeContextMenu(e, node));
  node.addEventListener('mousedown', e => { if (e.button === 0 && !e.target.closest('.port')) selectNode(node, e.shiftKey); });
  node.querySelectorAll('.port').forEach(port => {
    if (port.dataset.portType === 'output') {
      port.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        startConnectionDrag(port, e);
      });
    }
  });
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
document.querySelectorAll('.palette-item').forEach(item => {
  item.addEventListener('dragstart', e => {
    e.dataTransfer.setData('type', item.dataset.type);
    e.dataTransfer.setData('icon', item.dataset.icon || '');
  });
});

wrapper.addEventListener('dragover', e => e.preventDefault());
wrapper.addEventListener('drop', e => {
  e.preventDefault();
  const type = e.dataTransfer.getData('type');
  if (!type) return;
  const rect = wrapper.getBoundingClientRect();
  let x = (e.clientX - rect.left - translateX) / scale - 80;
  let y = (e.clientY - rect.top  - translateY) / scale - 45;
  saveState();
  createNode(type, x, y, e.dataTransfer.getData('icon'));
});
wrapper.addEventListener('mousedown', e => {
  if (e.target === wrapper || e.target.closest('#canvas') && !e.target.closest('.node')) deselectAll();
});

function createNode(type, x, y, icon = '') {
  const node = document.createElement('div');
  node.className = 'node';
  node.style.left = x + 'px';
  node.style.top  = y + 'px';
  node.dataset.id = String(nodeCounter++);
  node.dataset.type = type;
  node.dataset.rate = '0';
  node.dataset.item = getDefaultItem(type);
  if (type === 'miner') node.dataset.miningRate = '60';

  const typeLabel = (type === 'foundry' ? 'Foundry' : type === 'refinery' ? 'Refinery' : type.charAt(0).toUpperCase() + type.slice(1));
  node.innerHTML = `
    <div class="node-header">${icon} ${typeLabel}</div>
    <div class="node-rate-wrap"><input type="text" inputmode="decimal" class="node-rate" value="0" /><span class="node-rate-unit">/ min</span></div>
  `;
  node.querySelector('.node-rate').addEventListener('input', e => {
    node.dataset.rate = e.target.value.replace(',', '.');
  });
  node.querySelector('.node-rate').addEventListener('change', e => {
    const v = parseFloat(String(e.target.value).replace(',', '.'));
    if (!isNaN(v) && v >= 0) node.dataset.rate = String(v);
    e.target.value = node.dataset.rate;
  });

  const portsContainer = document.createElement('div');
  portsContainer.style.cssText = 'position:absolute;inset:0;pointer-events:auto';

  const outPort = createPort('output', 'output');
  portsContainer.appendChild(outPort);

  if (type === 'miner') {
    // only output
  } else if (type === 'smelter') {
    portsContainer.appendChild(createPort('input', 'input-1'));
  } else if (type === 'constructor') {
    portsContainer.appendChild(createPort('input', 'input-1'));
    portsContainer.appendChild(createPort('input', 'input-2'));
  } else if (type === 'assembler') {
    for (let i = 1; i <= 4; i++) portsContainer.appendChild(createPort('input', 'input-' + i));
  } else if (type === 'foundry') {
    portsContainer.appendChild(createPort('input', 'input-1'));
    portsContainer.appendChild(createPort('input', 'input-2'));
  } else if (type === 'refinery') {
    portsContainer.appendChild(createPort('input', 'input-1'));
    portsContainer.appendChild(createPort('input', 'input-2'));
    portsContainer.appendChild(createPort('input', 'input-3'));
  } else {
    portsContainer.appendChild(createPort('input', 'input-1'));
  }

  node.appendChild(portsContainer);
  canvas.appendChild(node);
  nodes.push(node);
  nodeById.set(node.dataset.id, node);

  makeDraggable(node);
  node.addEventListener('dblclick', () => editNode(node));
  node.addEventListener('contextmenu', e => showNodeContextMenu(e, node));
  node.addEventListener('mousedown', e => { if (e.button === 0 && !e.target.closest('.port')) selectNode(node, e.shiftKey); });

  node.querySelectorAll('.port').forEach(port => {
    if (port.dataset.portType === 'output') {
      port.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        startConnectionDrag(port, e);
      });
    }
  });

  return node;
}

function createPort(type, className = '') {
  const port = document.createElement('div');
  port.className = `port ${type} ${className}`;
  port.dataset.portType = type;
  return port;
}

// Mining rate options (per min) for Miner buildings
// Production options per building type (item label + recipe data for calculation)
const productionOptions = {
  miner: [
    { item: 'Iron Ore', out: 60 },
    { item: 'Copper Ore', out: 60 },
    { item: 'Limestone', out: 60 },
    { item: 'Coal', out: 60 },
    { item: 'Caterium Ore', out: 60 }
  ],
  smelter: [
    { item: 'Iron Ingot', in: 30, out: 30 },
    { item: 'Copper Ingot', in: 30, out: 30 },
    { item: 'Caterium Ingot', in: 45, out: 15 }
  ],
  constructor: [
    { item: 'Iron Plate', in: 30, out: 20 },
    { item: 'Iron Rod', in: 15, out: 15 },
    { item: 'Screw', in: 10, out: 40 },
    { item: 'Concrete', in: 45, out: 15 },
    { item: 'Copper Sheet', in: 20, out: 10 }
  ],
  assembler: [
    { item: 'Reinforced Iron Plate', in: 30, in2: 60, out: 5 },
    { item: 'Modular Frame', in: 24, in2: 12, out: 4 },
    { item: 'Rotor', in: 20, in2: 10, out: 4 },
    { item: 'Smart Plating', in: 30, in2: 30, out: 2 },
    { item: 'Cable', in: 30, in2: 60, out: 30 }
  ],
  foundry: [
    { item: 'Steel Ingot', in: 45, in2: 45, out: 45 },
    { item: 'Solid Steel Ingot', in: 20, in2: 20, out: 60 }
  ],
  refinery: [
    { item: 'Plastic', in: 30, in2: 20, out: 20 },
    { item: 'Rubber', in: 30, in2: 20, out: 20 },
    { item: 'Fuel', in: 60, in2: 40, out: 40 }
  ]
};

function getRecipeForNode(node) {
  const type = node.dataset.type;
  const item = node.dataset.item;
  const opts = productionOptions[type];
  if (!opts) return null;
  const r = opts.find(o => o.item === item);
  const base = r || opts[0] || null;
  if (!base) return null;
  if (type === 'miner' && node.dataset.miningRate) {
    const rate = parseInt(node.dataset.miningRate, 10);
    if (!isNaN(rate)) return { ...base, out: rate };
  }
  return base;
}

function getDefaultItem(type) {
  const opts = productionOptions[type];
  return (opts && opts[0] && opts[0].item) ? opts[0].item : 'Item';
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

const BUILDING_TYPES = [
  { type: 'miner', label: 'Miner Mk.1', icon: '⛏️' },
  { type: 'smelter', label: 'Smelter', icon: '♨️' },
  { type: 'constructor', label: 'Constructor', icon: '🔩' },
  { type: 'assembler', label: 'Assembler', icon: '⚙️' },
  { type: 'foundry', label: 'Foundry', icon: '🏭' },
  { type: 'refinery', label: 'Refinery', icon: '🛢️' }
];

let addNodeDialogSourcePort = null;
let addNodeDialogDropX = 0;
let addNodeDialogDropY = 0;

function openAddNodeDialog(sourcePort, dropX, dropY) {
  addNodeDialogSourcePort = sourcePort;
  addNodeDialogDropX = dropX;
  addNodeDialogDropY = dropY;
  const listEl = document.getElementById('add-node-dialog-list');
  listEl.innerHTML = '';
  BUILDING_TYPES.filter(b => b.type !== 'miner')
    .forEach(({ type, label, icon }) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'add-node-option';
    btn.dataset.type = type;
    btn.dataset.icon = icon;
    btn.innerHTML = `<span class="add-node-icon">${icon}</span><span>${label}</span>`;
    btn.addEventListener('click', () => {
      saveState();
      const node = createNode(type, addNodeDialogDropX - 80, addNodeDialogDropY - 45, icon);
      const toPort = node.querySelector('.port.input');
      if (toPort && addNodeDialogSourcePort) {
        const srcNode = addNodeDialogSourcePort.closest('.node');
        if (srcNode) {
          connections.push({
            fromNode: srcNode.dataset.id,
            fromPort: addNodeDialogSourcePort.className,
            toNode: node.dataset.id,
            toPort: toPort.className
          });
          drawConnection(addNodeDialogSourcePort, toPort);
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
    if (port && port.dataset.portType === 'input' && port.closest('.node') !== sourcePort.closest('.node')) {
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

    if (targetPort && targetPort.dataset.portType === 'input') {
      const targetNode = targetPort.closest('.node');
      if (targetNode && targetNode !== sourceNode) {
        saveState();
        connections.push({
          fromNode: sourceNode.dataset.id,
          fromPort: sourcePort.className,
          toNode: targetNode.dataset.id,
          toPort: targetPort.className
        });
        drawConnection(sourcePort, targetPort);
      } else if (targetNode === sourceNode) {
        toast('Cannot connect a node to itself');
      }
    } else {
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
  const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
  line.classList.add("connection");
  svg.appendChild(line);

  updateLinePath(line, fromPort, toPort);
  line.dataset.fromNode = fromPort.closest('.node').dataset.id;
  line.dataset.toNode   = toPort.closest('.node').dataset.id;
  line.dataset.fromPortClass = fromPort.className;
  line.dataset.toPortClass   = toPort.className;
}

function getPortCenter(port, canvasRect) {
  const rect = port.getBoundingClientRect();
  const cr = canvasRect || canvas.getBoundingClientRect();
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

  const canvasRect = canvas.getBoundingClientRect();
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
      toUpdate.push({ line, p1, p2, dx, curvature });
    }
  }

  for (let i = 0; i < toUpdate.length; i++) {
    const { line, p1, p2, dx, curvature } = toUpdate[i];
    const hx1 = p1.x + dx * curvature;
    const hx2 = p2.x - dx * curvature;
    line.setAttribute("d", `M${p1.x},${p1.y} C${hx1},${p1.y} ${hx2},${p2.y} ${p2.x},${p2.y}`);
  }
}

// ─── Calculation (multi-input + toast) ───────────
function getIncomingByPort(nodeId) {
  const list = connections.filter(c => c.toNode === nodeId);
  list.sort((a, b) => (a.toPort || '').localeCompare(b.toPort || ''));
  return list;
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

  if (safety >= 50) toast('Possible loop or complex graph', true);
  else toast('Rates calculated');
};

// ─── Export ──────────────────────────────────────
document.getElementById('export-btn').onclick = () => {
  const data = {
    nodes: nodes.map(n => ({
      id: n.dataset.id,
      type: n.dataset.type,
      x: parseFloat(n.style.left),
      y: parseFloat(n.style.top),
      rate: n.dataset.rate,
      item: n.dataset.item,
      name: n.querySelector('.node-header')?.textContent?.trim(),
      ...(n.dataset.miningRate && { miningRate: n.dataset.miningRate })
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
const editRateInput = document.getElementById('edit-dialog-rate');
let editDialogNode = null;

function openEditDialog(node) {
  editDialogNode = node;
  editNameInput.value = node.querySelector('.node-header').textContent.trim();
  editRateInput.value = node.dataset.rate ?? node.querySelector('.node-rate')?.value ?? '0';

  const type = node.dataset.type;
  const opts = productionOptions[type] || [];
  editProductionSelect.innerHTML = '';
  opts.forEach(r => {
    const opt = document.createElement('option');
    opt.value = r.item;
    opt.textContent = r.item;
    editProductionSelect.appendChild(opt);
  });
  editProductionSelect.value = node.dataset.item || (opts[0] && opts[0].item) || '';

  editOverlay.classList.add('show');
  editNameInput.focus();
  editNameInput.select();

  const focusables = editOverlay.querySelectorAll('button, input, select');
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
  editDialogNode = null;
}

function saveEditDialog() {
  if (!editDialogNode) return;
  const node = editDialogNode;
  const name = editNameInput.value.trim();
  if (name) node.querySelector('.node-header').textContent = name;
  const item = editProductionSelect.value;
  if (item) node.dataset.item = item;
  const rateStr = String(editRateInput.value).trim().replace(',', '.');
  const rateNum = parseFloat(rateStr);
  if (rateStr !== '' && !isNaN(rateNum) && rateNum >= 0) {
    node.dataset.rate = String(rateNum);
    if (node.dataset.type === 'miner') node.dataset.miningRate = String(rateNum);
    const rateEl = node.querySelector('.node-rate');
    if (rateEl) rateEl.value = String(rateNum);
  }
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
  if (line) line.remove();
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
    if (line.dataset.fromNode === id || line.dataset.toNode === id) line.remove();
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
