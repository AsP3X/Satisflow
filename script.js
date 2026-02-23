(function () {
  'use strict';

  const canvasRoot = document.getElementById('canvas-root');
  const canvasNodes = document.getElementById('canvas-nodes');
  const canvasSvg = document.getElementById('canvas-svg');
  const canvasBackdrop = document.getElementById('canvas-backdrop');
  const wrapper = document.querySelector('.canvas-area');

  let nodes = [];
  let connections = [];
  let nodeById = new Map();
  let nodeCounter = 0;
  let scale = 1;
  let translateX = 0;
  let translateY = 0;
  let selectedNodes = new Set();
  let rafLines = null;

  const MAX_UNDO = 50;
  let undoStack = [];
  let redoStack = [];

  let APP_CONFIG = null;
  let machinesList = [];
  let recipeListByMachine = {};

  const MACHINE_ICONS = {
    miner: '⛏',
    smelter: '♨',
    constructor: '◇',
    assembler: '⚙',
    foundry: '🏭',
    refinery: '🛢',
    storage_container: '📦',
    splitter: '⇉',
    merger: '⇄'
  };

  function getMachineDef(type) {
    return (APP_CONFIG && APP_CONFIG.machines && APP_CONFIG.machines[type]) || null;
  }

  function getInputCount(type) {
    const def = getMachineDef(type);
    if (def && def.inputCount != null) return def.inputCount;
    const map = { miner: 0, smelter: 1, constructor: 2, assembler: 2, foundry: 2, refinery: 3, storage_container: 1, splitter: 1, merger: 3 };
    return map[type] ?? 1;
  }

  function getOutputCount(type) {
    const def = getMachineDef(type);
    return (def && def.outputCount != null) ? def.outputCount : 1;
  }

  function buildConfigLookups() {
    if (!APP_CONFIG || !APP_CONFIG.machines || !APP_CONFIG.recipes) return;
    machinesList = [];
    recipeListByMachine = {};
    for (const [type, def] of Object.entries(APP_CONFIG.machines)) {
      const name = def.name || type;
      (def.tiers || []).forEach(tier => {
        machinesList.push({
          type,
          tierId: tier.id || 'mk1',
          tierName: tier.name || 'Mk.1',
          label: `${name} ${tier.name || ''}`.trim(),
          icon: MACHINE_ICONS[type] || '◇'
        });
      });
    }
    for (const recipe of APP_CONFIG.recipes) {
      const machine = recipe.machine;
      if (!machine) continue;
      if (!Array.isArray(recipeListByMachine[machine])) recipeListByMachine[machine] = [];
      const out = recipe.outputs && recipe.outputs[0];
      const outPerMin = out ? (out.amount / recipe.craftingTimeSeconds) * 60 : 0;
      const insPerMin = (recipe.inputs || []).map(inp => (inp.amount / recipe.craftingTimeSeconds) * 60);
      recipeListByMachine[machine].push({
        id: recipe.id,
        name: recipe.name,
        item: out?.item || recipe.name,
        craftingTimeSeconds: recipe.craftingTimeSeconds,
        inputs: recipe.inputs || [],
        outputs: recipe.outputs || [],
        insPerMin,
        outPerMin
      });
    }
  }

  function getMinerOreQualities() {
    const def = getMachineDef('miner');
    const list = (def && def.oreQualities && Array.isArray(def.oreQualities)) ? def.oreQualities : [];
    return list.length ? list : [{ id: 'normal', name: 'Normal', multiplier: 1 }];
  }

  function getMinerOreQualityMultiplier(qualityId) {
    const qualities = getMinerOreQualities();
    const q = qualities.find(x => x.id === qualityId) || qualities[0];
    return (q && typeof q.multiplier === 'number') ? q.multiplier : 1;
  }

  function getMinerDefaultOreQualityId() {
    const q = getMinerOreQualities();
    return (q[0] && q[0].id) || 'normal';
  }

  function getMinerCalculatedRate(tierId, qualityId) {
    const def = getMachineDef('miner');
    if (!def || !def.tiers) return 60;
    const tier = def.tiers.find(t => t.id === tierId) || def.tiers[0];
    const maxOut = (tier && tier.maxOutputPerMin != null) ? tier.maxOutputPerMin : 60;
    return maxOut * getMinerOreQualityMultiplier(qualityId);
  }

  function getCraftingMachineCalculatedRate(type, tierId, itemName) {
    const opts = recipeListByMachine[type];
    if (!opts || !opts.length) return 0;
    const r = opts.find(o => o.item === itemName || o.name === itemName) || opts[0];
    if (!r || r.outPerMin == null) return 0;
    const def = getMachineDef(type);
    const tier = (def && def.tiers) ? def.tiers.find(t => t.id === tierId) : null;
    const speed = (tier && tier.craftingSpeed != null) ? tier.craftingSpeed : 1;
    return r.outPerMin * speed;
  }

  function hasFixedRate(type) {
    return type === 'miner' || type === 'smelter';
  }

  function getDefaultItem(type) {
    const opts = recipeListByMachine[type];
    return (opts && opts[0] && (opts[0].item || opts[0].name)) ? (opts[0].item || opts[0].name) : 'Item';
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
    const speed = (tier && tier.craftingSpeed != null) ? tier.craftingSpeed : (tier && tier.miningSpeed != null) ? tier.miningSpeed : 1;
    if (type === 'miner') {
      const out = getMinerCalculatedRate(tierId, node.dataset.oreQuality || getMinerDefaultOreQualityId());
      return { ...r, outPerMin: out, insPerMin: [] };
    }
    return {
      ...r,
      outPerMin: (r.outPerMin != null ? r.outPerMin * speed : 0),
      insPerMin: (r.insPerMin || []).map(rate => rate * speed)
    };
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
        x: parseFloat(n.style.left) || 0,
        y: parseFloat(n.style.top) || 0,
        rate: n.dataset.rate,
        item: n.dataset.item,
        name: n.querySelector('.node-drag')?.textContent?.trim().replace(/^[\s\S]*?([^\s].*)$/, '$1') || '',
        oreQuality: n.dataset.oreQuality,
        miningRate: n.dataset.miningRate
      })),
      connections: connections.map(c => ({ ...c })),
      nodeCounter
    };
  }

  function restoreState(state) {
    canvasNodes.innerHTML = '';
    canvasSvg.querySelectorAll('.connection-group').forEach(g => g.remove());
    nodes = [];
    nodeById.clear();
    connections = [];
    nodeCounter = (state.nodeCounter != null) ? state.nodeCounter : Math.max(0, ...(state.nodes.map(n => Number(n.id)) || [0])) + 1;
    (state.nodes || []).forEach(nd => {
      const node = createNodeFromData(nd);
      nodes.push(node);
      nodeById.set(node.dataset.id, node);
      canvasNodes.appendChild(node);
    });
    (state.connections || []).forEach(c => {
      const fromNode = nodeById.get(String(c.fromNode));
      const toNode = nodeById.get(String(c.toNode));
      if (!fromNode || !toNode) return;
      const fromPort = findPortByClass(fromNode, c.fromPort) || fromNode.querySelector('.port.output');
      const toPort = findPortByClass(toNode, c.toPort) || toNode.querySelector('.port.input');
      if (fromPort && toPort) {
        connections.push({
          fromNode: fromNode.dataset.id,
          fromPort: fromPort.className.trim(),
          toNode: toNode.dataset.id,
          toPort: (toPort.closest('.port-wrap') ? toPort.closest('.port-wrap').className : toPort.className).trim()
        });
        drawConnection(fromPort, toPort);
      }
    });
    updateAllLines();
    nodes.forEach(n => updateNodeIOLabels(n));
    updateEmptyState();
  }

  function findPortByClass(node, portClass) {
    if (!node || !portClass) return null;
    const wraps = node.querySelectorAll('.port-wrap');
    for (const w of wraps) {
      if (w.className.replace(/\s+/g, ' ').trim() === portClass.trim()) return w.querySelector('.port');
    }
    const list = node.querySelectorAll('.port');
    for (const p of list) {
      if (p.className.replace(/\s+/g, ' ').trim() === portClass.trim()) return p;
    }
    return null;
  }

  function getCanvasPoint(clientX, clientY) {
    const rect = wrapper.getBoundingClientRect();
    return {
      x: (clientX - rect.left - translateX) / scale,
      y: (clientY - rect.top - translateY) / scale
    };
  }

  function getPortCenter(port, useRect) {
    const rect = port.getBoundingClientRect();
    const cr = useRect || wrapper.getBoundingClientRect();
    return {
      x: (rect.left + rect.width / 2 - cr.left - translateX) / scale,
      y: (rect.top + rect.height / 2 - cr.top - translateY) / scale
    };
  }

  function createPort(kind, portClass) {
    const port = document.createElement('div');
    port.className = `port ${kind} ${portClass}`.trim();
    port.dataset.portKind = kind;
    return port;
  }

  function createInputPortWrap(portClass) {
    const wrap = document.createElement('div');
    wrap.className = `port-wrap ${portClass}`.trim();
    const port = createPort('input', portClass);
    const label = document.createElement('span');
    label.className = 'port-label';
    wrap.appendChild(port);
    wrap.appendChild(label);
    return wrap;
  }

  function buildNodeElement(data) {
    const { type, tierId, x, y, id, rate, item, name, oreQuality } = data;
    const def = getMachineDef(type);
    const tier = (def && def.tiers) ? (def.tiers.find(t => t.id === tierId) || def.tiers[0]) : null;
    const tierName = tier?.name || '';
    const flowSuffix = (type === 'splitter' || type === 'merger') && tier && tier.maxFlowPerMin != null ? ` · ${tier.maxFlowPerMin}/min` : '';
    const typeLabel = def ? `${def.name} ${tierName}${flowSuffix}`.trim() : type;
    const icon = MACHINE_ICONS[type] || '◇';
    const displayName = name || `${icon} ${typeLabel}`.trim();
    const product = item || getDefaultItem(type);
    let outRate = rate;
    if (type === 'miner') {
      outRate = String(getMinerCalculatedRate(tierId, oreQuality || getMinerDefaultOreQualityId()));
    } else if (type === 'smelter') {
      outRate = String(getCraftingMachineCalculatedRate(type, tierId, product));
    } else if (outRate === undefined || outRate === '') {
      outRate = '0';
    }

    const node = document.createElement('div');
    node.className = 'node';
    node.style.left = (x || 0) + 'px';
    node.style.top = (y || 0) + 'px';
    node.dataset.id = String(id);
    node.dataset.type = type;
    node.dataset.tier = tierId || 'mk1';
    node.dataset.rate = String(outRate);
    node.dataset.item = product || getDefaultItem(type);
    if (type === 'miner') {
      node.dataset.oreQuality = oreQuality || getMinerDefaultOreQualityId();
      node.dataset.miningRate = node.dataset.rate;
    }

    node.innerHTML = `
      <div class="node-drag">
        <span class="node-drag-icon">${icon}</span>
        <span class="node-drag-title">${displayName}</span>
      </div>
      <div class="node-product">${node.dataset.item}</div>
      <div class="node-io">
        <div class="node-output">Out: <span class="node-io-value">${formatRate(node.dataset.rate)}</span>/min</div>
        <div class="node-inputs" id="node-inputs-${node.dataset.id}"></div>
        <div class="node-efficiency" id="node-eff-${node.dataset.id}"></div>
      </div>
    `;

    const portsContainer = document.createElement('div');
    portsContainer.className = 'node-ports';
    const outputCount = getOutputCount(type);
    for (let i = 1; i <= outputCount; i++) {
      const p = createPort('output', outputCount > 1 ? 'output-' + i : 'output');
      portsContainer.appendChild(p);
    }
    const inputCount = getInputCount(type);
    for (let i = 1; i <= inputCount; i++) {
      portsContainer.appendChild(createInputPortWrap('input-' + i));
    }
    node.appendChild(portsContainer);

    return node;
  }

  function formatRate(v) {
    const n = parseFloat(v);
    if (isNaN(n)) return '0';
    if (Number.isInteger(n)) return String(n);
    return n.toFixed(1);
  }

  function createNodeFromData(nd) {
    const id = nd.id != null ? nd.id : nodeCounter++;
    const node = buildNodeElement({
      type: nd.type || 'miner',
      tierId: nd.tier || 'mk1',
      x: nd.x,
      y: nd.y,
      id,
      rate: nd.rate,
      item: nd.item,
      name: nd.name,
      oreQuality: nd.oreQuality
    });
    canvasNodes.appendChild(node);
    makeDraggable(node);
    node.addEventListener('dblclick', () => openEditModal(node));
    node.addEventListener('contextmenu', e => showNodeMenu(e, node));
    node.addEventListener('mousedown', e => {
      if (e.button === 0 && !e.target.closest('.port')) selectNode(node, e.shiftKey);
    });
    node.querySelectorAll('.port').forEach(port => {
      port.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        startConnectionDrag(port, e);
      });
    });
    updateNodeIOLabels(node);
    return node;
  }

  function createNode(type, x, y, tierId, icon, item) {
    saveState();
    const node = buildNodeElement({
      type,
      tierId: tierId || 'mk1',
      x: x - 100,
      y: y - 50,
      id: nodeCounter++,
      rate: '0',
      item: item || getDefaultItem(type),
      name: '',
      oreQuality: type === 'miner' ? getMinerDefaultOreQualityId() : undefined
    });
    nodes.push(node);
    nodeById.set(node.dataset.id, node);
    canvasNodes.appendChild(node);
    makeDraggable(node);
    node.addEventListener('dblclick', () => openEditModal(node));
    node.addEventListener('contextmenu', e => showNodeMenu(e, node));
    node.addEventListener('mousedown', e => {
      if (e.button === 0 && !e.target.closest('.port')) selectNode(node, e.shiftKey);
    });
    node.querySelectorAll('.port').forEach(port => {
      port.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        startConnectionDrag(port, e);
      });
    });
    updateNodeIOLabels(node);
    updateEmptyState();
    return node;
  }

  function selectNode(node, add) {
    if (!add) selectedNodes.clear();
    selectedNodes.add(node);
    nodes.forEach(n => n.classList.toggle('selected', selectedNodes.has(n)));
  }

  function deselectAll() {
    selectedNodes.clear();
    nodes.forEach(n => n.classList.remove('selected'));
  }

  function updateNodeIOLabels(node) {
    const rate = parseFloat(node.dataset.rate || 0);
    const outEl = node.querySelector('.node-output .node-io-value');
    if (outEl) outEl.textContent = formatRate(rate);

    const inputsEl = node.querySelector('.node-inputs');
    const effEl = node.querySelector('.node-efficiency');
    if (!inputsEl) return;

    const type = node.dataset.type;
    const recipe = getRecipeForNode(node);
    const incoming = connections.filter(c => c.toNode === node.dataset.id);

    inputsEl.innerHTML = '';
    effEl.textContent = '';
    effEl.className = 'node-efficiency';
    effEl.hidden = true;

    if (type === 'splitter' || type === 'merger') {
      if (incoming.length > 0) {
        const totalIn = incoming.reduce((sum, c) => {
          const src = nodeById.get(c.fromNode);
          return sum + (parseFloat(src?.dataset?.rate || 0) || 0);
        }, 0);
        inputsEl.innerHTML = `<div class="node-io-row">In: <span>${formatRate(totalIn)}/min</span></div>`;
      }
      return;
    }

    if (!recipe || !recipe.insPerMin || recipe.insPerMin.length === 0) {
      if (recipe && recipe.inputs && recipe.inputs.length) {
        const scale = rate > 0 && recipe.outPerMin > 0 ? rate / recipe.outPerMin : 1;
        recipe.inputs.forEach((inp, i) => {
          const need = (recipe.insPerMin && recipe.insPerMin[i]) ? recipe.insPerMin[i] * scale : (inp.amount / recipe.craftingTimeSeconds) * 60 * scale;
          const row = document.createElement('div');
          row.className = 'node-io-row';
          const conn = incoming.find(c => c.toPort && c.toPort.includes('input-' + (i + 1)));
          const received = conn ? (parseFloat(nodeById.get(conn.fromNode)?.dataset?.rate || 0) || 0) : 0;
          row.textContent = `${inp.item}: ${formatRate(received)} / ${formatRate(need)}/min`;
          inputsEl.appendChild(row);
        });
      }
      return;
    }

    let efficiency = 1;
    recipe.inputs.forEach((inp, i) => {
      const need = recipe.insPerMin[i] != null ? (rate / (recipe.outPerMin || 1)) * recipe.insPerMin[i] : 0;
      const conn = incoming.find(c => (c.toPort || '').includes('input-' + (i + 1)));
      const received = conn ? (parseFloat(nodeById.get(conn.fromNode)?.dataset?.rate || 0) || 0) : 0;
      const row = document.createElement('div');
      row.className = 'node-io-row';
      row.textContent = `${inp.item}: ${formatRate(received)} / ${formatRate(need)}/min`;
      inputsEl.appendChild(row);
      if (need > 0 && received < need) {
        const eff = received / need;
        if (eff < efficiency) efficiency = eff;
      }
    });

    if (efficiency < 1 && recipe.outPerMin > 0) {
      effEl.hidden = false;
      effEl.textContent = `Efficiency: ${(efficiency * 100).toFixed(0)}%`;
      if (efficiency >= 0.99) effEl.classList.add('ok');
    } else if (efficiency >= 1 && recipe.outPerMin > 0) {
      effEl.hidden = false;
      effEl.textContent = 'Efficiency: 100%';
      effEl.classList.add('ok');
    }

    // Unconnected input port labels (required rate)
    node.querySelectorAll('.port-wrap').forEach(wrap => {
    const port = wrap.querySelector('.port');
    const labelEl = wrap.querySelector('.port-label');
    if (!port || !labelEl) return;
    const isConnected = connections.some(c => c.toNode === node.dataset.id && (c.toPort || '').includes(wrap.className));
    if (isConnected) {
      labelEl.textContent = '';
      labelEl.classList.remove('visible');
      return;
    }
    const recipe = getRecipeForNode(node);
    if (!recipe?.inputs?.length) {
      labelEl.classList.remove('visible');
      return;
    }
    const match = wrap.className.match(/input-(\d+)/);
    const idx = match ? parseInt(match[1], 10) - 1 : 0;
    const inp = recipe.inputs[idx];
    const needPerMin = (recipe.insPerMin && recipe.insPerMin[idx] != null)
      ? (parseFloat(node.dataset.rate || 0) / (recipe.outPerMin || 1)) * recipe.insPerMin[idx]
      : 0;
    if (!inp || needPerMin <= 0) {
      labelEl.classList.remove('visible');
      return;
    }
    labelEl.textContent = `${inp.item} ${formatRate(needPerMin)}/min`;
    labelEl.classList.add('visible');
  });
  }

  function makeDraggable(el) {
    let dragging = false;
    let startX, startY, startLeft, startTop;

    const onDown = e => {
      if (e.button !== 0 || e.target.closest('.port')) return;
      e.preventDefault();
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      startLeft = parseFloat(el.style.left) || 0;
      startTop = parseFloat(el.style.top) || 0;
      el.classList.add('dragging');
      document.body.style.userSelect = 'none';
    };

    const onMove = e => {
      if (!dragging) return;
      const dx = (e.clientX - startX) / scale;
      const dy = (e.clientY - startY) / scale;
      el.style.left = (startLeft + dx) + 'px';
      el.style.top = (startTop + dy) + 'px';
      scheduleUpdateLines();
    };

    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      el.classList.remove('dragging');
      document.body.style.userSelect = '';
    };

    el.addEventListener('mousedown', onDown);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function scheduleUpdateLines() {
    if (rafLines) return;
    rafLines = requestAnimationFrame(() => {
      rafLines = null;
      updateAllLines();
    });
  }

  function updateTransform() {
    canvasRoot.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
    scheduleUpdateLines();
  }

  wrapper.addEventListener('wheel', e => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    scale = Math.max(0.25, Math.min(3, scale + delta));
    updateTransform();
  });

  let panning = false;
  let panStartX, panStartY;
  wrapper.addEventListener('mousedown', e => {
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      panning = true;
      panStartX = e.clientX - translateX;
      panStartY = e.clientY - translateY;
      wrapper.style.cursor = 'grabbing';
    }
  });
  window.addEventListener('mousemove', e => {
    if (!panning) return;
    translateX = e.clientX - panStartX;
    translateY = e.clientY - panStartY;
    updateTransform();
  });
  window.addEventListener('mouseup', () => {
    panning = false;
    wrapper.style.cursor = '';
  });

  document.getElementById('zoom-in').addEventListener('click', () => { scale = Math.min(3, scale + 0.2); updateTransform(); });
  document.getElementById('zoom-out').addEventListener('click', () => { scale = Math.max(0.25, scale - 0.2); updateTransform(); });
  document.getElementById('zoom-reset').addEventListener('click', () => { scale = 1; translateX = translateY = 0; updateTransform(); });
  document.getElementById('zoom-fit').addEventListener('click', () => {
    if (nodes.length === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    nodes.forEach(n => {
      const x = parseFloat(n.style.left) || 0;
      const y = parseFloat(n.style.top) || 0;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + 220);
      maxY = Math.max(maxY, y + 120);
    });
    const w = maxX - minX + 80;
    const h = maxY - minY + 80;
    const rect = wrapper.getBoundingClientRect();
    scale = Math.min(rect.width / w, rect.height / h, 2);
    translateX = rect.width / 2 - ((minX + maxX) / 2) * scale;
    translateY = rect.height / 2 - ((minY + maxY) / 2) * scale;
    updateTransform();
  });

  canvasBackdrop.addEventListener('mousedown', e => {
    if (e.target === canvasBackdrop || e.target.closest('.canvas-root') && !e.target.closest('.node')) deselectAll();
  });

  function updateEmptyState() {
    const el = document.getElementById('empty-state');
    if (!el) return;
    el.classList.toggle('hidden', nodes.length > 0);
    el.setAttribute('aria-hidden', nodes.length > 0 ? 'true' : 'false');
  }

  function getIncomingByPort(nodeId) {
    return connections.filter(c => c.toNode === nodeId).sort((a, b) => (a.toPort || '').localeCompare(b.toPort || ''));
  }

  function getOutgoingConnections(nodeId) {
    return connections.filter(c => c.fromNode === nodeId);
  }

  function runCalculate() {
    nodes.forEach(n => {
      n.dataset.rate = '0';
    });

    const hasIncoming = new Set(connections.map(c => c.toNode));
    const sources = nodes.filter(n => !hasIncoming.has(n.dataset.id));

    sources.forEach(n => {
      const r = getRecipeForNode(n);
      if (r && r.outPerMin != null) {
        n.dataset.rate = String(r.outPerMin);
        if (n.dataset.type === 'miner') n.dataset.miningRate = n.dataset.rate;
      }
    });

    const topo = [];
    const visited = new Set();
    const queue = [...sources.map(n => n.dataset.id)];
    while (queue.length) {
      const id = queue.shift();
      if (visited.has(id)) continue;
      visited.add(id);
      const node = nodeById.get(id);
      if (node) topo.push(node);
      getIncomingByPort(id).forEach(c => {
        if (!visited.has(c.fromNode)) queue.push(c.fromNode);
      });
    }

    const reverseOrder = [...topo].reverse();

    for (const node of reverseOrder) {
      const type = node.dataset.type;
      const incoming = getIncomingByPort(node.dataset.id);
      let outRate = 0;

      if (type === 'splitter') {
        if (incoming.length === 1) {
          const src = nodeById.get(incoming[0].fromNode);
          const inRate = parseFloat(src?.dataset?.rate || 0) || 0;
          outRate = inRate;
          node.dataset.item = src?.dataset?.item || node.dataset.item || 'Item';
        }
      } else if (type === 'merger') {
        incoming.forEach(c => {
          const src = nodeById.get(c.fromNode);
          outRate += parseFloat(src?.dataset?.rate || 0) || 0;
        });
        if (incoming.length) node.dataset.item = nodeById.get(incoming[0].fromNode)?.dataset?.item || node.dataset.item || 'Item';
      } else if (type !== 'miner' && recipeListByMachine[type] && recipeListByMachine[type].length) {
        const recipe = getRecipeForNode(node);
        if (recipe && recipe.outPerMin > 0) {
          const inputs = incoming.map(c => parseFloat(nodeById.get(c.fromNode)?.dataset?.rate || 0) || 0);
          const needRates = (recipe.insPerMin || []).slice(0, inputs.length);
          let efficiency = 1;
          needRates.forEach((need, i) => {
            if (need > 0 && inputs[i] != null) {
              const eff = inputs[i] / need;
              if (eff < efficiency) efficiency = eff;
            }
          });
          outRate = efficiency * recipe.outPerMin;
        }
      }

      if (outRate > 0) node.dataset.rate = String(outRate);
    }

    for (let pass = 0; pass < 3; pass++) {
      for (const node of topo) {
        const type = node.dataset.type;
        const incoming = getIncomingByPort(node.dataset.id);
        if (incoming.length === 0) continue;

        let outRate = 0;
        if (type === 'splitter') {
          if (incoming.length === 1) {
            const src = nodeById.get(incoming[0].fromNode);
            outRate = parseFloat(src?.dataset?.rate || 0) || 0;
            node.dataset.item = src?.dataset?.item || node.dataset.item || 'Item';
          }
        } else if (type === 'merger') {
          incoming.forEach(c => {
            outRate += parseFloat(nodeById.get(c.fromNode)?.dataset?.rate || 0) || 0;
          });
          if (incoming.length) node.dataset.item = nodeById.get(incoming[0].fromNode)?.dataset?.item || node.dataset.item || 'Item';
        } else {
          const recipe = getRecipeForNode(node);
          if (recipe && recipe.outPerMin > 0) {
            const inputs = incoming.map(c => parseFloat(nodeById.get(c.fromNode)?.dataset?.rate || 0) || 0);
            const needRates = (recipe.insPerMin || []).slice(0, inputs.length);
            let efficiency = 1;
            needRates.forEach((need, i) => {
              if (need > 0 && inputs[i] != null) {
                const eff = inputs[i] / need;
                if (eff < efficiency) efficiency = eff;
              }
            });
            outRate = efficiency * recipe.outPerMin;
          }
        }
        if (outRate > 0) node.dataset.rate = String(outRate);
      }
    }

    backwardPass();

    nodes.forEach(n => updateNodeIOLabels(n));
    updateAllLines();
    toast('Rates calculated');
  }

  function backwardPass() {
    const sinks = nodes.filter(n => !getOutgoingConnections(n.dataset.id).length);
    const order = [];
    const seen = new Set();
    let queue = [...sinks.map(n => n.dataset.id)];
    while (queue.length) {
      const id = queue.shift();
      if (seen.has(id)) continue;
      seen.add(id);
      const node = nodeById.get(id);
      if (node) order.push(node);
      getIncomingByPort(id).forEach(c => {
        if (!seen.has(c.fromNode)) queue.push(c.fromNode);
      });
    }

    order.forEach(downstream => {
      const rate = parseFloat(downstream.dataset.rate || 0);
      if (rate <= 0) return;
      const recipe = getRecipeForNode(downstream);
      if (!recipe || !recipe.outPerMin) return;
      const scale = rate / recipe.outPerMin;
      const incoming = getIncomingByPort(downstream.dataset.id);
      (recipe.inputs || []).forEach((inp, i) => {
        const need = (recipe.insPerMin && recipe.insPerMin[i] != null) ? recipe.insPerMin[i] * scale : 0;
        if (need <= 0) return;
        const conn = incoming.find(c => (c.toPort || '').includes('input-' + (i + 1)));
        if (!conn) return;
        const fromNode = nodeById.get(conn.fromNode);
        if (!fromNode) return;
        const current = parseFloat(fromNode.dataset.rate || 0);
        let required = Math.max(current, need);
        if (hasFixedRate(fromNode.dataset.type)) {
          const maxOut = fromNode.dataset.type === 'miner'
            ? getMinerCalculatedRate(fromNode.dataset.tier || 'mk1', fromNode.dataset.oreQuality || getMinerDefaultOreQualityId())
            : getCraftingMachineCalculatedRate(fromNode.dataset.type, fromNode.dataset.tier || 'mk1', fromNode.dataset.item);
          required = Math.min(required, maxOut);
        }
        fromNode.dataset.rate = String(required);
        if (fromNode.dataset.type === 'miner') fromNode.dataset.miningRate = fromNode.dataset.rate;
      });
    });
  }

  let connectionDragSource = null;
  let connectionPreviewPath = null;
  let connectionDropTarget = null;

  function startConnectionDrag(sourcePort, e) {
    if (connectionDragSource) return;
    connectionDragSource = sourcePort;
    sourcePort.classList.add('connecting');
    document.body.style.cursor = 'crosshair';

    const p1 = getPortCenter(sourcePort);
    connectionPreviewPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    connectionPreviewPath.setAttribute('class', 'connection-preview');
    connectionPreviewPath.setAttribute('d', `M${p1.x},${p1.y} L${p1.x},${p1.y}`);
    canvasSvg.appendChild(connectionPreviewPath);

    const onMove = e => {
      const p2 = getCanvasPoint(e.clientX, e.clientY);
      const dx = p2.x - p1.x;
      const curvature = 0.35;
      const hx1 = p1.x + dx * curvature;
      const hx2 = p2.x - dx * curvature;
      connectionPreviewPath.setAttribute('d', `M${p1.x},${p1.y} C${hx1},${p1.y} ${hx2},${p2.y} ${p2.x},${p2.y}`);

      if (connectionDropTarget) {
        connectionDropTarget.classList.remove('drop-target');
        connectionDropTarget = null;
      }
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const port = under?.classList?.contains('port') ? under : under?.closest?.('.port');
      const sourceIsOut = sourcePort.dataset.portKind === 'output';
      const valid = port && port.closest('.node') !== sourcePort.closest('.node') &&
        (sourceIsOut ? port.dataset.portKind === 'input' : port.dataset.portKind === 'output');
      if (valid) {
        port.classList.add('drop-target');
        connectionDropTarget = port;
      }
    };

    const onUp = e => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      connectionDragSource.classList.remove('connecting');
      connectionDragSource = null;
      if (connectionDropTarget) {
        connectionDropTarget.classList.remove('drop-target');
      }

      let targetPort = connectionDropTarget;
      if (!targetPort) {
        const under = document.elementFromPoint(e.clientX, e.clientY);
        targetPort = under?.classList?.contains('port') ? under : under?.closest?.('.port');
      }
      if (connectionDropTarget) connectionDropTarget.classList.remove('drop-target');
      connectionDropTarget = null;

      const sourceNode = sourcePort.closest('.node');
      const sourceIsOut = sourcePort.dataset.portKind === 'output';
      const targetIsIn = targetPort?.dataset?.portKind === 'input';
      const targetIsOut = targetPort?.dataset?.portKind === 'output';
      const canConnect = (sourceIsOut && targetIsIn) || (!sourceIsOut && targetIsOut);

      if (targetPort && canConnect) {
        const targetNode = targetPort.closest('.node');
        if (targetNode && targetNode !== sourceNode) {
          saveState();
          let fromNode, fromPort, toNode, toPort;
          const toPortWrap = targetPort.closest('.port-wrap');
          const toPortClass = toPortWrap ? toPortWrap.className.trim() : targetPort.className.trim();
          const fromPortClass = sourcePort.closest('.port-wrap') ? sourcePort.closest('.port-wrap').className.trim() : sourcePort.className.trim();
          if (sourceIsOut) {
            fromNode = sourceNode.dataset.id;
            fromPort = fromPortClass;
            toNode = targetNode.dataset.id;
            toPort = toPortClass;
            drawConnection(sourcePort, targetPort);
          } else {
            fromNode = targetNode.dataset.id;
            fromPort = toPortClass;
            toNode = sourceNode.dataset.id;
            toPort = fromPortClass;
            drawConnection(targetPort, sourcePort);
          }
          connections.push({ fromNode, fromPort, toNode, toPort });
          const toN = nodeById.get(toNode);
          if (toN) updateNodeIOLabels(toN);
        } else {
          toast('Cannot connect to same node');
        }
      } else {
        const pt = getCanvasPoint(e.clientX, e.clientY);
        openAddAndConnectModal(sourcePort, pt.x, pt.y);
      }

      if (connectionPreviewPath?.parentNode) connectionPreviewPath.remove();
      connectionPreviewPath = null;
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function drawConnection(fromPort, toPort) {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'connection-group');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('class', 'connection-line');
    const labelBg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    labelBg.setAttribute('class', 'connection-label-bg');
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('class', 'connection-label');
    g.appendChild(path);
    g.appendChild(labelBg);
    g.appendChild(label);
    canvasSvg.appendChild(g);

    updateLinePath(path, fromPort, toPort);
    path.dataset.fromNode = fromPort.closest('.node').dataset.id;
    path.dataset.toNode = toPort.closest('.node').dataset.id;
    path.dataset.fromPort = (fromPort.closest('.port-wrap') || fromPort).className.trim();
    path.dataset.toPort = (toPort.closest('.port-wrap') || toPort).className.trim();
  }

  function updateLinePath(path, fromPort, toPort, rect) {
    const p1 = getPortCenter(fromPort, rect);
    const p2 = getPortCenter(toPort, rect);
    const dx = p2.x - p1.x;
    const curvature = 0.35;
    const hx1 = p1.x + dx * curvature;
    const hx2 = p2.x - dx * curvature;
    path.setAttribute('d', `M${p1.x},${p1.y} C${hx1},${p1.y} ${hx2},${p2.y} ${p2.x},${p2.y}`);
  }

  function updateAllLines() {
    const rect = wrapper.getBoundingClientRect();
    const paths = canvasSvg.querySelectorAll('.connection-line');
    paths.forEach(line => {
      const fromNode = nodeById.get(line.dataset.fromNode);
      const toNode = nodeById.get(line.dataset.toNode);
      if (!fromNode || !toNode) return;
      const fromPort = findPortByClass(fromNode, line.dataset.fromPort) || fromNode.querySelector('.port.output');
      const toPort = findPortByClass(toNode, line.dataset.toPort) || toNode.querySelector('.port.input');
      if (!fromPort || !toPort) return;
      updateLinePath(line, fromPort, toPort, rect);
      const g = line.closest('.connection-group');
      const labelEl = g?.querySelector('.connection-label');
      const labelBgEl = g?.querySelector('.connection-label-bg');
      const item = fromNode.dataset.item || 'Item';
      let rate = parseFloat(fromNode.dataset.rate || 0);
      if (fromNode.dataset.type === 'splitter') {
        const outCount = [...canvasSvg.querySelectorAll('.connection-line')].filter(l => l.dataset.fromNode === fromNode.dataset.id).length;
        if (outCount > 0) rate = rate / outCount;
      }
      if (labelEl) {
        labelEl.textContent = `${item} ${formatRate(rate)}/min`;
        const hx1 = 0, hx2 = 0;
        const p1 = getPortCenter(fromPort, rect);
        const p2 = getPortCenter(toPort, rect);
        const dx = p2.x - p1.x;
        const curvature = 0.35;
        const cx1 = p1.x + dx * curvature;
        const cx2 = p2.x - dx * curvature;
        const midX = (p1.x + 3 * cx1 + 3 * cx2 + p2.x) / 8;
        const midY = (p1.y + p2.y) / 2;
        labelEl.setAttribute('x', midX);
        labelEl.setAttribute('y', midY);
        if (labelBgEl) {
          try {
            const bbox = labelEl.getBBox();
            const pad = 4;
            labelBgEl.setAttribute('x', bbox.x - pad);
            labelBgEl.setAttribute('y', bbox.y - pad);
            labelBgEl.setAttribute('width', bbox.width + pad * 2);
            labelBgEl.setAttribute('height', bbox.height + pad * 2);
            labelBgEl.setAttribute('rx', 4);
            labelBgEl.setAttribute('ry', 4);
          } catch (_) {}
        }
      }
    });
  }

  function toast(msg, isWarning) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.toggle('warning', !!isWarning);
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 3000);
  }

  let pickerDropX = 0;
  let pickerDropY = 0;

  document.getElementById('menu-canvas').querySelector('[data-action="add-building"]').addEventListener('click', () => {
    closeNodeMenu();
    closeCanvasMenu();
    openPicker(pickerDropX, pickerDropY);
  });

  canvasBackdrop.addEventListener('contextmenu', e => {
    if (e.target.closest('.node') || e.target.closest('.zoom-bar')) return;
    e.preventDefault();
    const pt = getCanvasPoint(e.clientX, e.clientY);
    pickerDropX = pt.x;
    pickerDropY = pt.y;
    document.getElementById('menu-canvas').style.left = e.clientX + 'px';
    document.getElementById('menu-canvas').style.top = e.clientY + 'px';
    document.getElementById('menu-canvas').classList.add('show');
    document.getElementById('menu-canvas').setAttribute('aria-hidden', 'false');
    const close = () => {
      document.getElementById('menu-canvas').classList.remove('show');
      document.getElementById('menu-canvas').setAttribute('aria-hidden', 'true');
      document.removeEventListener('click', close);
    };
    setTimeout(() => document.addEventListener('click', close), 0);
  });

  function closeCanvasMenu() {
    document.getElementById('menu-canvas').classList.remove('show');
  }

  let menuNode = null;
  function showNodeMenu(e, node) {
    e.preventDefault();
    e.stopPropagation();
    menuNode = node;
    const menu = document.getElementById('menu-node');
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';
    menu.classList.add('show');
    menu.setAttribute('aria-hidden', 'false');
    setTimeout(() => document.addEventListener('click', closeNodeMenu), 0);
  }

  function closeNodeMenu() {
    document.getElementById('menu-node').classList.remove('show');
    document.getElementById('menu-node').setAttribute('aria-hidden', 'true');
    menuNode = null;
  }

  document.getElementById('menu-node').querySelectorAll('.menu-item').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      if (!menuNode) return;
      const action = btn.dataset.action;
      if (action === 'edit') openEditModal(menuNode);
      else if (action === 'clear') { saveState(); clearNodeConnections(menuNode); }
      else if (action === 'delete') { saveState(); deleteNode(menuNode); }
      closeNodeMenu();
    });
  });

  function clearNodeConnections(node) {
    const id = node.dataset.id;
    connections = connections.filter(c => c.fromNode !== id && c.toNode !== id);
    canvasSvg.querySelectorAll('.connection-group').forEach(g => {
      const line = g.querySelector('.connection-line');
      if (line && (line.dataset.fromNode === id || line.dataset.toNode === id)) g.remove();
    });
    nodes.forEach(n => updateNodeIOLabels(n));
    updateAllLines();
  }

  function deleteNode(node) {
    clearNodeConnections(node);
    nodeById.delete(node.dataset.id);
    nodes = nodes.filter(n => n !== node);
    node.remove();
    updateEmptyState();
  }

  function openPicker(x, y) {
    pickerDropX = x;
    pickerDropY = y;
    const overlay = document.getElementById('picker-overlay');
    const tabsEl = document.getElementById('picker-tabs');
    const itemsEl = document.getElementById('picker-items');
    const searchEl = document.getElementById('picker-search');
    const machineOrder = APP_CONFIG && APP_CONFIG.machines ? Object.keys(APP_CONFIG.machines) : [];
    const byType = {};
    machinesList.forEach(m => {
      if (!byType[m.type]) byType[m.type] = [];
      byType[m.type].push(m);
    });

    tabsEl.innerHTML = '';
    let activeType = machineOrder[0] || '';
    machineOrder.forEach(type => {
      if (!byType[type]?.length) return;
      const def = getMachineDef(type);
      const name = def?.name || type;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'picker-tab' + (type === activeType ? ' active' : '');
      btn.textContent = name;
      btn.dataset.type = type;
      btn.addEventListener('click', () => {
        activeType = type;
        tabsEl.querySelectorAll('.picker-tab').forEach(t => t.classList.remove('active'));
        btn.classList.add('active');
        renderPickerItems(itemsEl, byType[activeType] || [], searchEl?.value?.trim() || '');
      });
      tabsEl.appendChild(btn);
    });

    function renderPickerItems(container, list, query) {
      container.innerHTML = '';
      const filtered = query ? list.filter(m => (m.label || '').toLowerCase().includes(query.toLowerCase())) : list;
      filtered.forEach(({ type, tierId, label, icon }) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'picker-item';
        btn.innerHTML = `<span class="picker-item-icon">${icon}</span><span>${label}</span>`;
        btn.addEventListener('click', () => {
          createNode(type, pickerDropX, pickerDropY, tierId, icon);
          overlay.classList.remove('show');
          overlay.setAttribute('aria-hidden', 'true');
        });
        container.appendChild(btn);
      });
    }

    renderPickerItems(itemsEl, byType[activeType] || [], '');
    if (searchEl) {
      searchEl.value = '';
      searchEl.oninput = () => renderPickerItems(itemsEl, byType[activeType] || [], searchEl.value.trim());
    }

    overlay.classList.add('show');
    overlay.setAttribute('aria-hidden', 'false');
    searchEl?.focus();
  }

  document.getElementById('picker-close').addEventListener('click', () => {
    document.getElementById('picker-overlay').classList.remove('show');
    document.getElementById('picker-overlay').setAttribute('aria-hidden', 'true');
  });

  document.getElementById('picker-overlay').addEventListener('click', e => {
    if (e.target.id === 'picker-overlay') {
      document.getElementById('picker-overlay').classList.remove('show');
      document.getElementById('picker-overlay').setAttribute('aria-hidden', 'true');
    }
  });

  let addConnectSourcePort = null;
  let addConnectX = 0;
  let addConnectY = 0;

  function openAddAndConnectModal(sourcePort, x, y) {
    addConnectSourcePort = sourcePort;
    addConnectX = x;
    addConnectY = y;
    const listEl = document.getElementById('modal-add-list');
    listEl.innerHTML = '';
    const excludeMiner = sourcePort.dataset.portKind === 'output';
    const list = excludeMiner ? machinesList.filter(m => m.type !== 'miner') : machinesList;
    list.forEach(({ type, tierId, label, icon }) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'modal-add-option';
      btn.innerHTML = `<span class="modal-add-option-icon">${icon}</span><span>${label}</span>`;
      btn.addEventListener('click', () => {
        saveState();
        const node = createNode(type, addConnectX, addConnectY, tierId, icon);
        const srcNode = addConnectSourcePort.closest('.node');
        if (srcNode && node) {
          const fromPort = addConnectSourcePort.dataset.portKind === 'output' ? addConnectSourcePort : node.querySelector('.port.output');
          const toPort = addConnectSourcePort.dataset.portKind === 'input' ? addConnectSourcePort : node.querySelector('.port.input');
          if (fromPort && toPort) {
            const fromN = fromPort.closest('.node');
            const toN = toPort.closest('.node');
            const fromPortClass = fromPort.closest('.port-wrap') ? fromPort.closest('.port-wrap').className.trim() : fromPort.className.trim();
            const toPortClass = toPort.closest('.port-wrap') ? toPort.closest('.port-wrap').className.trim() : toPort.className.trim();
            connections.push({
              fromNode: fromN.dataset.id,
              fromPort: fromPortClass,
              toNode: toN.dataset.id,
              toPort: toPortClass
            });
            drawConnection(fromPort, toPort);
            updateNodeIOLabels(toN);
          }
        }
        document.getElementById('modal-add-overlay').classList.remove('show');
        document.getElementById('modal-add-overlay').setAttribute('aria-hidden', 'true');
      });
      listEl.appendChild(btn);
    });
    document.getElementById('modal-add-overlay').classList.add('show');
    document.getElementById('modal-add-overlay').setAttribute('aria-hidden', 'false');
  }

  document.getElementById('add-cancel').addEventListener('click', () => {
    document.getElementById('modal-add-overlay').classList.remove('show');
    document.getElementById('modal-add-overlay').setAttribute('aria-hidden', 'true');
  });

  document.getElementById('modal-add-overlay').addEventListener('click', e => {
    if (e.target.id === 'modal-add-overlay') {
      document.getElementById('modal-add-overlay').classList.remove('show');
      document.getElementById('modal-add-overlay').setAttribute('aria-hidden', 'true');
    }
  });

  let editNodeRef = null;
  const editName = document.getElementById('edit-name');
  const editRecipe = document.getElementById('edit-recipe');
  const editRecipeHint = document.getElementById('edit-recipe-hint');
  const editRate = document.getElementById('edit-rate');
  const editOreWrap = document.getElementById('edit-ore-wrap');
  const editOre = document.getElementById('edit-ore');

  function openEditModal(node) {
    editNodeRef = node;
    editName.value = (node.querySelector('.node-drag-title')?.textContent || '').replace(/^[\s\S]*?([^\s].*)$/, '$1').trim();
    const type = node.dataset.type;
    const opts = recipeListByMachine[type] || [];
    editRecipe.innerHTML = '';
    opts.forEach(r => {
      const opt = document.createElement('option');
      opt.value = r.item || r.name;
      opt.textContent = r.item || r.name;
      editRecipe.appendChild(opt);
    });
    editRecipe.value = node.dataset.item || (opts[0] && (opts[0].item || opts[0].name)) || '';
    if (hasFixedRate(type)) {
      const rate = type === 'miner'
        ? getMinerCalculatedRate(node.dataset.tier || 'mk1', node.dataset.oreQuality || getMinerDefaultOreQualityId())
        : getCraftingMachineCalculatedRate(type, node.dataset.tier || 'mk1', node.dataset.item);
      editRate.value = String(rate);
      editRate.readOnly = true;
    } else {
      editRate.value = node.dataset.rate || '0';
      editRate.readOnly = false;
    }
    updateEditRecipeHint();
    if (type === 'miner') {
      editOreWrap.hidden = false;
      editOre.innerHTML = '';
      getMinerOreQualities().forEach(q => {
        const opt = document.createElement('option');
        opt.value = q.id;
        opt.textContent = q.name;
        editOre.appendChild(opt);
      });
      editOre.value = node.dataset.oreQuality || getMinerDefaultOreQualityId();
    } else {
      editOreWrap.hidden = true;
    }
    document.getElementById('modal-edit-overlay').classList.add('show');
    document.getElementById('modal-edit-overlay').setAttribute('aria-hidden', 'false');
    editName.focus();
  }

  function updateEditRecipeHint() {
    if (!editNodeRef) return;
    const type = editNodeRef.dataset.type;
    const item = editRecipe?.value;
    const opts = recipeListByMachine[type] || [];
    const recipe = opts.find(r => (r.item || r.name) === item) || opts[0];
    if (!recipe || !recipe.inputs?.length) {
      editRecipeHint.textContent = '';
      return;
    }
    const rate = parseFloat(editRate?.value || 0) || 0;
    const scale = recipe.outPerMin > 0 ? rate / recipe.outPerMin : 1;
    const parts = (recipe.inputs || []).slice(0, 4).map((inp, i) => {
      const base = recipe.insPerMin?.[i] ?? (inp.amount / recipe.craftingTimeSeconds) * 60;
      return `${formatRate(base * scale)}/min ${inp.item}`;
    });
    editRecipeHint.textContent = 'Inputs: ' + parts.join(', ');
  }

  editRecipe?.addEventListener('change', updateEditRecipeHint);
  editRate?.addEventListener('input', updateEditRecipeHint);

  function closeEditModal() {
    document.getElementById('modal-edit-overlay').classList.remove('show');
    document.getElementById('modal-edit-overlay').setAttribute('aria-hidden', 'true');
    editNodeRef = null;
  }

  function saveEditModal() {
    if (!editNodeRef) return;
    const node = editNodeRef;
    const name = editName.value.trim();
    if (name) {
      const titleEl = node.querySelector('.node-drag-title');
      if (titleEl) titleEl.textContent = name;
    }
    const item = editRecipe?.value;
    if (item) node.dataset.item = item;
    const productEl = node.querySelector('.node-product');
    if (productEl) productEl.textContent = node.dataset.item || '';
    if (hasFixedRate(node.dataset.type)) {
      if (node.dataset.type === 'miner' && editOre?.value) node.dataset.oreQuality = editOre.value;
      const rate = node.dataset.type === 'miner'
        ? getMinerCalculatedRate(node.dataset.tier || 'mk1', node.dataset.oreQuality || getMinerDefaultOreQualityId())
        : getCraftingMachineCalculatedRate(node.dataset.type, node.dataset.tier || 'mk1', node.dataset.item);
      node.dataset.rate = String(rate);
      if (node.dataset.type === 'miner') node.dataset.miningRate = node.dataset.rate;
    } else {
      const v = parseFloat(String(editRate?.value || '0').replace(',', '.'));
      if (!isNaN(v) && v >= 0) node.dataset.rate = String(v);
    }
    updateNodeIOLabels(node);
    updateAllLines();
    closeEditModal();
  }

  document.getElementById('edit-cancel').addEventListener('click', closeEditModal);
  document.getElementById('edit-save').addEventListener('click', saveEditModal);
  document.getElementById('modal-edit-overlay').addEventListener('click', e => {
    if (e.target.id === 'modal-edit-overlay') closeEditModal();
  });
  editName.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeEditModal();
    if (e.key === 'Enter') saveEditModal();
  });

  document.getElementById('btn-calculate').addEventListener('click', runCalculate);

  document.getElementById('btn-export').addEventListener('click', () => {
    const data = {
      nodes: nodes.map(n => ({
        id: n.dataset.id,
        type: n.dataset.type,
        tier: n.dataset.tier,
        x: parseFloat(n.style.left) || 0,
        y: parseFloat(n.style.top) || 0,
        rate: n.dataset.rate,
        item: n.dataset.item,
        name: n.querySelector('.node-drag-title')?.textContent?.trim() || '',
        oreQuality: n.dataset.oreQuality,
        miningRate: n.dataset.miningRate
      })),
      connections: connections.map(c => ({ ...c })),
      nodeCounter
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'satisflow.json';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Exported');
  });

  document.getElementById('btn-import').addEventListener('click', () => document.getElementById('file-import').click());
  document.getElementById('file-import').addEventListener('change', e => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data.nodes || !Array.isArray(data.nodes)) {
          toast('Invalid file: missing nodes', true);
          return;
        }
        saveState();
        restoreState({
          nodes: data.nodes,
          connections: data.connections || [],
          nodeCounter: data.nodeCounter
        });
        toast('Imported');
      } catch (err) {
        toast('Invalid JSON', true);
      }
    };
    reader.readAsText(file);
  });

  document.getElementById('btn-theme').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('satisflow-theme', next);
  });

  const savedTheme = localStorage.getItem('satisflow-theme');
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;

  document.getElementById('btn-shortcuts').addEventListener('click', () => {
    document.getElementById('shortcuts-overlay').classList.add('show');
    document.getElementById('shortcuts-overlay').setAttribute('aria-hidden', 'false');
  });
  document.getElementById('shortcuts-close').addEventListener('click', () => {
    document.getElementById('shortcuts-overlay').classList.remove('show');
    document.getElementById('shortcuts-overlay').setAttribute('aria-hidden', 'true');
  });
  document.getElementById('shortcuts-overlay').addEventListener('click', e => {
    if (e.target.id === 'shortcuts-overlay') {
      document.getElementById('shortcuts-overlay').classList.remove('show');
      document.getElementById('shortcuts-overlay').setAttribute('aria-hidden', 'true');
    }
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (document.getElementById('shortcuts-overlay').classList.contains('show')) {
        document.getElementById('shortcuts-overlay').classList.remove('show');
        return;
      }
      if (document.getElementById('modal-edit-overlay').classList.contains('show')) closeEditModal();
      else if (document.getElementById('menu-node').classList.contains('show')) closeNodeMenu();
      else if (document.getElementById('picker-overlay').classList.contains('show')) {
        document.getElementById('picker-overlay').classList.remove('show');
      } else if (document.getElementById('modal-add-overlay').classList.contains('show')) {
        document.getElementById('modal-add-overlay').classList.remove('show');
      } else deselectAll();
      e.preventDefault();
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (document.activeElement?.closest('.modal')) return;
      if (selectedNodes.size > 0) {
        saveState();
        [...selectedNodes].forEach(n => deleteNode(n));
        deselectAll();
        e.preventDefault();
      }
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
      e.preventDefault();
      if (e.shiftKey) {
        if (redoStack.length) {
          undoStack.push(serializeState());
          restoreState(redoStack.pop());
          toast('Redo');
        }
      } else {
        if (undoStack.length) {
          redoStack.push(serializeState());
          restoreState(undoStack.pop());
          toast('Undo');
        }
      }
    }
    if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey && !/^(INPUT|TEXTAREA|SELECT)$/.test((e.target?.tagName || ''))) {
      e.preventDefault();
      const so = document.getElementById('shortcuts-overlay');
      so.classList.toggle('show', !so.classList.contains('show'));
    }
  });

  const DEFAULT_CONFIG = {"machines":{"miner":{"name":"Miner","inputCount":0,"outputCount":1,"oreQualities":[{"id":"impure","name":"Impure","multiplier":0.5},{"id":"normal","name":"Normal","multiplier":1},{"id":"pure","name":"Pure","multiplier":2}],"tiers":[{"id":"mk1","name":"Mk.1","maxOutputPerMin":60},{"id":"mk2","name":"Mk.2","maxOutputPerMin":120},{"id":"mk3","name":"Mk.3","maxOutputPerMin":240}]},"smelter":{"name":"Smelter","inputCount":1,"outputCount":1,"tiers":[{"id":"mk1","name":"Mk.1","craftingSpeed":1},{"id":"mk2","name":"Mk.2","craftingSpeed":2},{"id":"mk3","name":"Mk.3","craftingSpeed":4}]},"constructor":{"name":"Constructor","inputCount":2,"outputCount":1,"tiers":[{"id":"mk1","name":"Mk.1","craftingSpeed":1},{"id":"mk2","name":"Mk.2","craftingSpeed":2},{"id":"mk3","name":"Mk.3","craftingSpeed":4}]},"assembler":{"name":"Assembler","inputCount":2,"outputCount":1,"tiers":[{"id":"mk1","name":"Mk.1","craftingSpeed":1},{"id":"mk2","name":"Mk.2","craftingSpeed":2},{"id":"mk3","name":"Mk.3","craftingSpeed":4}]},"foundry":{"name":"Foundry","inputCount":2,"outputCount":1,"tiers":[{"id":"mk1","name":"Mk.1","craftingSpeed":1},{"id":"mk2","name":"Mk.2","craftingSpeed":2},{"id":"mk3","name":"Mk.3","craftingSpeed":4}]},"refinery":{"name":"Refinery","inputCount":3,"outputCount":1,"tiers":[{"id":"mk1","name":"Mk.1","craftingSpeed":1},{"id":"mk2","name":"Mk.2","craftingSpeed":2},{"id":"mk3","name":"Mk.3","craftingSpeed":4}]},"storage_container":{"name":"Storage Container","inputCount":1,"outputCount":1,"tiers":[{"id":"mk1","name":"Mk.1"}]},"splitter":{"name":"Splitter","inputCount":1,"outputCount":3,"tiers":[{"id":"mk1","name":"Mk.1","maxFlowPerMin":60},{"id":"mk2","name":"Mk.2","maxFlowPerMin":120},{"id":"mk3","name":"Mk.3","maxFlowPerMin":270},{"id":"mk4","name":"Mk.4","maxFlowPerMin":480},{"id":"mk5","name":"Mk.5","maxFlowPerMin":780},{"id":"mk6","name":"Mk.6","maxFlowPerMin":1200}]},"merger":{"name":"Merger","inputCount":3,"outputCount":1,"tiers":[{"id":"mk1","name":"Mk.1","maxFlowPerMin":60},{"id":"mk2","name":"Mk.2","maxFlowPerMin":120},{"id":"mk3","name":"Mk.3","maxFlowPerMin":270},{"id":"mk4","name":"Mk.4","maxFlowPerMin":480},{"id":"mk5","name":"Mk.5","maxFlowPerMin":780},{"id":"mk6","name":"Mk.6","maxFlowPerMin":1200}]}},"recipes":[{"id":"iron_ingot","name":"Iron Ingot","machine":"smelter","craftingTimeSeconds":2,"inputs":[{"item":"Iron Ore","amount":1}],"outputs":[{"item":"Iron Ingot","amount":1}]},{"id":"iron_ore","name":"Iron Ore","machine":"miner","craftingTimeSeconds":1,"inputs":[],"outputs":[{"item":"Iron Ore","amount":60}]}]};

  function init() {
    APP_CONFIG = DEFAULT_CONFIG;
    buildConfigLookups();
    const listEl = document.getElementById('palette-list');
    if (listEl) {
      listEl.innerHTML = '';
      machinesList.forEach(({ type, tierId, label, icon }) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'palette-item';
        btn.innerHTML = `<span class="palette-item-icon">${icon}</span><span>${label}</span>`;
        btn.addEventListener('click', () => {
          const rect = wrapper.getBoundingClientRect();
          const cx = rect.width / 2 - 100;
          const cy = rect.height / 2 - 50;
          const pt = getCanvasPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          createNode(type, pt.x, pt.y, tierId, icon);
        });
        listEl.appendChild(btn);
      });
    }
    updateEmptyState();
  }

  function loadConfig() {
    const statusEl = document.getElementById('config-status');
    fetch('config.json')
      .then(r => { if (!r.ok) throw new Error(); return r.json(); })
      .then(config => {
        APP_CONFIG = config;
        buildConfigLookups();
        const listEl = document.getElementById('palette-list');
        if (listEl) {
          listEl.innerHTML = '';
          machinesList.forEach(({ type, tierId, label, icon }) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'palette-item';
            btn.innerHTML = `<span class="palette-item-icon">${icon}</span><span>${label}</span>`;
            btn.addEventListener('click', () => {
              const rect = wrapper.getBoundingClientRect();
              const pt = getCanvasPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
              createNode(type, pt.x, pt.y, tierId, icon);
            });
            listEl.appendChild(btn);
          });
        }
        if (statusEl) statusEl.textContent = '';
        updateEmptyState();
      })
      .catch(() => {
        if (statusEl) statusEl.textContent = 'Using built-in config';
        init();
      });
  }

  loadConfig();
  if (!APP_CONFIG) init();
})();
