(() => {
  'use strict';

  const LEGACY_STORAGE_KEY = 'blockplan.minecraft.floorplan.v1';
  const WORKSPACE_STORAGE_KEY = 'blockplan.minecraft.workspaces.v1';
  const MAX_PROJECTS = 24;
  const MAX_HISTORY = 70;
  const MAX_FLOORS = 20;
  const $ = id => document.getElementById(id);
  const canvas = $('planCanvas');
  const viewport = $('viewport');
  const ctx = canvas.getContext('2d');
  const toolButtons = [...document.querySelectorAll('[data-tool]')];
  const EXTRA_TYPES = ["toilet", "sink", "shower", "furnace", "fridge", "bath", "table", "chair", "counter"];
  const RECT_FIXTURES = ['bath', 'table'];
  const LINE_FIXTURES = ['counter'];

  const createFloor = (name, copy) => ({
    id: makeId(),
    name,
    blocks: copy ? { ...copy.blocks } : {},
    doors: copy ? { ...copy.doors } : {},
    windows: copy ? { ...copy.windows } : {},
    beds: copy ? { ...copy.beds } : {},
    stairs: copy ? { ...copy.stairs } : {},
    fixtures: copy ? JSON.parse(JSON.stringify(copy.fixtures || {})) : {},
    labels: copy ? copy.labels.map(label => ({ ...label, id: makeId() })) : [],
    boundary: copy?.boundary ? { ...copy.boundary } : null
  });

  function makeId() { return Math.random().toString(36).slice(2, 11) + Date.now().toString(36); }
  function newState(name = 'My Minecraft Build') {
    const floor = createFloor('Floor 1');
    return { version: 3, projectName: name, cols: 48, rows: 32, floors: [floor], activeFloorId: floor.id };
  }
  function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
  const cellKey = (x, y) => `${x},${y}`;
  const readKey = key => key.split(',').map(Number);
  const snapshot = () => JSON.stringify(state);
  const activeFloor = () => state.floors.find(floor => floor.id === state.activeFloorId) || state.floors[0];
  const activeIndex = () => state.floors.findIndex(floor => floor.id === state.activeFloorId);

  // Never inject imported text as HTML. Convert a JSON file to the limited plan format.
  function normalizePlan(input) {
    if (!input || typeof input !== 'object' || !Array.isArray(input.floors) || !input.floors.length || input.floors.length > MAX_FLOORS) throw Error('This file is not a valid BlockPlan project.');
    const cols = Number(input.cols);
    const rows = Number(input.rows);
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 8 || cols > 120 || rows < 8 || rows > 120) throw Error('Grid dimensions must be between 8 and 120 blocks.');
    const floors = input.floors.map((source, index) => {
      if (!source || typeof source !== 'object') throw Error('Invalid floor data.');
      const floor = createFloor(typeof source.name === 'string' ? source.name.slice(0, 40) || `Floor ${index + 1}` : `Floor ${index + 1}`);
      if (source.blocks && typeof source.blocks === 'object' && !Array.isArray(source.blocks)) {
        for (const key of Object.keys(source.blocks)) {
          const match = /^(\d+),(\d+)$/.exec(key);
          if (match && Number(match[1]) < cols && Number(match[2]) < rows && source.blocks[key]) floor.blocks[key] = true;
        }
      }
      if (source.doors && typeof source.doors === 'object' && !Array.isArray(source.doors)) {
        for (const [key, angle] of Object.entries(source.doors)) {
          const match = /^(\d+),(\d+)$/.exec(key);
          if (match && Number(match[1]) < cols && Number(match[2]) < rows && Number.isInteger(angle) && angle >= 0 && angle <= 3) {
            floor.doors[key] = angle;
            delete floor.blocks[key];
          }
        }
      }
      if (source.windows && typeof source.windows === 'object' && !Array.isArray(source.windows)) {
        for (const [key, rotation] of Object.entries(source.windows)) {
          const match = /^(\d+),(\d+)$/.exec(key);
          if (match && Number(match[1]) < cols && Number(match[2]) < rows && Number.isInteger(rotation) && rotation >= 0 && rotation <= 3) {
            placeWindow(floor, { x: Number(match[1]), y: Number(match[2]) }, rotation);
          }
        }
      }
      if (source.stairs && typeof source.stairs === 'object' && !Array.isArray(source.stairs)) {
        for (const [key, rotation] of Object.entries(source.stairs)) {
          const match = /^(\d+),(\d+)$/.exec(key);
          if (match && Number(match[1]) < cols && Number(match[2]) < rows && Number.isInteger(rotation) && rotation >= 0 && rotation <= 3) {
            placeStair(floor, { x: Number(match[1]), y: Number(match[2]) }, rotation);
          }
        }
      }
      if (source.beds && typeof source.beds === 'object' && !Array.isArray(source.beds)) {
        for (const [key, rotation] of Object.entries(source.beds)) {
          const match = /^(\d+),(\d+)$/.exec(key);
          if (match && Number.isInteger(rotation) && rotation >= 0 && rotation <= 3) {
            const anchor = { x: Number(match[1]), y: Number(match[2]) };
            if (bedCells(anchor, rotation).every(cell => cell.x >= 0 && cell.y >= 0 && cell.x < cols && cell.y < rows)) placeBed(floor, anchor, rotation, { cols, rows });
          }
        }
      }
      if (source.fixtures && typeof source.fixtures === 'object' && !Array.isArray(source.fixtures)) {
        for (const [key, fixture] of Object.entries(source.fixtures)) {
          const match = /^(\d+),(\d+)$/.exec(key);
          if (!match || !fixture || !EXTRA_TYPES.includes(fixture.type) || !Number.isInteger(fixture.rotation) || fixture.rotation < 0 || fixture.rotation > 3) continue;
          const anchor = { x: +match[1], y: +match[2] };
          if (fixture.type === 'shower') {
            if (fixtureCells(anchor, fixture).every(c => c.x >= 0 && c.y >= 0 && c.x < cols && c.y < rows)) placeFixture(floor, anchor, fixture, {cols, rows});
          } else if (fixture.type === 'bath' || fixture.type === 'table') {
            // A dragged bath or table is stored as occupied cells, each with its own marker.
            if (anchor.x < cols && anchor.y < rows) placeFixture(floor, anchor, fixture, {cols, rows});
          } else if (anchor.x < cols && anchor.y < rows) placeFixture(floor, anchor, fixture, {cols, rows});
        }
      }
      if (Array.isArray(source.labels)) {
        floor.labels = source.labels.slice(0, 400).filter(label => label && typeof label.text === 'string' && Number.isInteger(label.x) && Number.isInteger(label.y) && label.x >= 0 && label.y >= 0 && label.x < cols && label.y < rows).map(label => ({ id: makeId(), x: label.x, y: label.y, text: label.text.slice(0, 50) }));
      }
      const b = source.boundary;
      if (b && [b.x1, b.y1, b.x2, b.y2].every(Number.isInteger) && b.x1 >= 0 && b.y1 >= 0 && b.x2 >= b.x1 && b.y2 >= b.y1 && b.x2 < cols && b.y2 < rows) floor.boundary = { x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 };
      return floor;
    });
    // Retain floor selection by its position even if the imported IDs are not trusted.
    const selectedIndex = input.floors.findIndex(floor => floor.id === input.activeFloorId);
    return { version: 3, projectName: typeof input.projectName === 'string' ? input.projectName.slice(0, 50) : 'My Minecraft Build', cols, rows, floors, activeFloorId: floors[Math.max(0, selectedIndex)].id };
  }

  function normalizeWorkspace(input) {
    if (!input || input.type !== 'blockplan-workspace' || !Array.isArray(input.projects) || !input.projects.length || input.projects.length > MAX_PROJECTS) throw Error('Not a valid BlockPlan workspace backup.');
    const ids = new Set();
    const projects = input.projects.map(entry => {
      const id = typeof entry.id === 'string' && entry.id.length < 100 && !ids.has(entry.id) ? entry.id : makeId();
      ids.add(id);
      return { id, plan: normalizePlan(entry.plan) };
    });
    const activeProjectId = projects.some(project => project.id === input.activeProjectId) ? input.activeProjectId : projects[0].id;
    return { projects, activeProjectId };
  }

  function loadWorkspace() {
    try {
      const raw = localStorage.getItem(WORKSPACE_STORAGE_KEY);
      if (raw) return normalizeWorkspace(JSON.parse(raw));
    } catch (error) { console.warn('Unable to restore saved workspace:', error); }
    // One-time migration from the original single-build version. Preserve the old key as a fallback backup.
    try {
      const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (raw) {
        const plan = normalizePlan(JSON.parse(raw));
        const id = makeId();
        return { projects: [{ id, plan }], activeProjectId: id };
      }
    } catch (error) { console.warn('Unable to restore previous BlockPlan project:', error); }
    const id = makeId();
    return { projects: [{ id, plan: newState() }], activeProjectId: id };
  }

  let workspace = loadWorkspace();
  let state = workspace.projects.find(project => project.id === workspace.activeProjectId).plan;
  const historyByProject = new Map();
  let undoStack = [];
  let redoStack = [];
  let tool = 'wall';
  const objectRotations = { door: 0, window: 0, bed: 0, stairs: 0, shower: 0, toilet: 0, sink: 0, furnace: 0, fridge: 0, chair: 0 };
  let showBelow = true;
  let gesture = null;
  let selection = null; // UI-only; not written into saved plans.
  let hovered = null;
  let measureMode = 'line';
  let measurement = null; // Temporary visual guide; never stored in JSON.
  let measurementContext = `${workspace.activeProjectId}:${state.activeFloorId}`;
  let spaceDown = false;
  let viewReady = false;
  let view = { x: 0, y: 0, size: 24 };
  let canvasWidth = 1;
  let canvasHeight = 1;
  let framePending = false;
  let hintDismissed = false;
  let toastTimer;
  let modalCallback = null;

  const HINTS = {
    wall: 'Click and drag to draw a straight wall, with a live length',
    rectangle: 'Drag from one corner to the opposite corner to draw four connected walls',
    block: 'Click and drag to paint individual blocks',
    select: 'Drag to select blocks, windows, doors, beds, stairs, fixtures and labels, then move the group',
    measure: 'Drag to measure a line, or choose Area for room dimensions and square blocks',
    door: 'Click to place a door, click an existing door to rotate',
    window: 'Click for one window or drag for a row, click existing windows to rotate',
    bed: 'Click to place a two-block bed, click an existing bed to rotate',
    stairs: 'Click or drag to mark stairs, click an existing stair to rotate',
    label: 'Click a cell to add or edit a room name',
    boundary: 'Drag diagonally to set your build boundary',
    erase: 'Drag to erase blocks, windows, doors, beds, stairs and labels',
    pan: 'Drag anywhere to move the canvas',
    toilet: 'Click to place one square',
    sink: 'Click to place one square',
    shower: 'Click to place, press R to rotate',
    furnace: 'Click to place one square',
    fridge: 'Click to place one square',
    bath: 'Drag to fill a rectangle',
    table: 'Drag to fill a rectangle',
    chair: 'Click to place one square',
    counter: 'Drag to draw a row'
  };

  function activeProject() { return workspace.projects.find(project => project.id === workspace.activeProjectId); }
  function save() {
    activeProject().plan = state;
    try {
      localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify({ type: 'blockplan-workspace', version: 1, ...workspace }));
      $('saveStatus').textContent = 'All builds saved';
    } catch (error) {
      console.warn('Could not save BlockPlan workspace:', error);
      $('saveStatus').textContent = 'Save failed, export a backup';
    }
  }

  function nextBuildName() {
    let number = 1;
    while (workspace.projects.some(project => project.plan.projectName === `Build ${number}`)) number++;
    return `Build ${number}`;
  }

  function switchBuild(id) {
    if (id === workspace.activeProjectId) return;
    const next = workspace.projects.find(project => project.id === id);
    if (!next) return;
    historyByProject.set(workspace.activeProjectId, { undo: undoStack, redo: redoStack });
    // Store the active plan before changing tabs, including any unsaved edits.
    activeProject().plan = state;
    workspace.activeProjectId = next.id;
    state = next.plan;
    const history = historyByProject.get(id);
    undoStack = history?.undo || [];
    redoStack = history?.redo || [];
    gesture = null;
    hovered = null;
    clearSelection();
    resetMeasurement();
    $('wallMeasure').hidden = true;
    save(); updateUI(); fitView(); revealActiveBuildTab();
  }

  function addBuild(copy = false, imported = null) {
    if (workspace.projects.length >= MAX_PROJECTS) { showToast(`Maximum of ${MAX_PROJECTS} builds open.`); return false; }
    const base = imported || (copy ? normalizePlan(JSON.parse(snapshot())) : newState(nextBuildName()));
    const plan = copy ? { ...base, projectName: `${base.projectName || 'Build'} copy`.slice(0, 50) } : base;
    const id = makeId();
    workspace.projects.push({ id, plan });
    switchBuild(id);
    showToast(imported ? `Imported "${plan.projectName}" into a new tab` : copy ? 'Build duplicated into a new tab' : 'New blank build created');
    return true;
  }

  function renameBuild() {
    const projectId = workspace.activeProjectId;
    openModal({
      title: 'Rename build', description: 'This name appears on the tab and in exported files.',
      fields: [{ name: 'name', label: 'Build name', value: state.projectName, maxLength: 50 }], button: 'Rename',
      onSubmit: values => {
        if (workspace.activeProjectId !== projectId) return false;
        change(() => { state.projectName = values.name.trim(); });
      }
    });
  }

  function closeBuild(id) {
    const index = workspace.projects.findIndex(project => project.id === id);
    if (index < 0) return;
    if (workspace.projects.length === 1) { showToast('Keep at least one build open.'); return; }
    const project = workspace.projects[index];
    if (!confirm(`Close and delete "${project.plan.projectName}"? This build will be removed from browser storage. Export it first if you want to keep it.`)) return;
    if (workspace.activeProjectId === id) {
      const replacement = workspace.projects[index + 1] || workspace.projects[index - 1];
      switchBuild(replacement.id);
    }
    workspace.projects.splice(index, 1);
    historyByProject.delete(id);
    save(); updateUI();
    showToast('Build closed');
  }

  function revealActiveBuildTab() {
    const tabs = $('buildTabs');
    const active = tabs.querySelector('.build-tab.active');
    if (!active) return;
    const viewRect = tabs.getBoundingClientRect();
    const tabRect = active.getBoundingClientRect();
    if (tabRect.right > viewRect.right) tabs.scrollLeft += tabRect.right - viewRect.right;
    if (tabRect.left < viewRect.left) tabs.scrollLeft += tabRect.left - viewRect.left;
  }

  function renderBuildTabs() {
    const tabs = $('buildTabs');
    const previousScroll = tabs.scrollLeft;
    tabs.replaceChildren();
    for (const project of workspace.projects) {
      const selected = project.id === workspace.activeProjectId;
      const wrapper = document.createElement('div');
      wrapper.className = `build-tab${selected ? ' active' : ''}`;
      const trigger = document.createElement('button');
      trigger.type = 'button'; trigger.className = 'build-tab-select';
      trigger.setAttribute('role', 'tab'); trigger.setAttribute('aria-selected', String(selected));
      trigger.setAttribute('aria-label', `Switch to ${project.plan.projectName}`);
      trigger.title = `${project.plan.projectName} (double-click to rename)`;
      trigger.innerHTML = '<svg class="icon"><use href="#i-cube"></use></svg>';
      const label = document.createElement('span'); label.textContent = project.plan.projectName || 'Untitled build';
      trigger.append(label);
      trigger.addEventListener('click', () => switchBuild(project.id));
      trigger.addEventListener('dblclick', () => { switchBuild(project.id); renameBuild(); });
      const close = document.createElement('button');
      close.type = 'button'; close.className = 'build-tab-close';
      close.textContent = '×'; close.title = `Close ${project.plan.projectName}`;
      close.setAttribute('aria-label', `Close ${project.plan.projectName}`);
      close.disabled = workspace.projects.length === 1;
      close.addEventListener('click', () => closeBuild(project.id));
      wrapper.append(trigger, close);
      tabs.appendChild(wrapper);
    }
    tabs.scrollLeft = previousScroll;
    $('duplicateBuild').disabled = workspace.projects.length >= MAX_PROJECTS;
    $('newBuild').disabled = workspace.projects.length >= MAX_PROJECTS;
  }

  function remember(before) {
    if (snapshot() === before) return false;
    undoStack.push(before);
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    redoStack.length = 0;
    save();
    updateUI();
    requestDraw();
    return true;
  }
  function change(action) { const before = snapshot(); action(); return remember(before); }
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(snapshot());
    state = JSON.parse(undoStack.pop());
    clearSelection();
    save(); updateUI(); requestDraw();
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(snapshot());
    state = JSON.parse(redoStack.pop());
    clearSelection();
    save(); updateUI(); requestDraw();
  }

  function showToast(message) {
    const toast = $('toast');
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
  }

  function setTool(nextTool) {
    if (nextTool !== 'select') clearSelection();
    tool = nextTool;
    const activeButton = toolButtons.find(button => button.dataset.tool === nextTool);
    if (activeButton) {
      activeButton.closest('.tool-group').open = true;
      // The settings belong directly under the tool being edited, not at the
      // bottom of its group. Moving the existing node retains its listeners.
      const panelId = { select: 'selectControls', measure: 'measureControls', boundary: 'boundaryControls' }[nextTool];
      if (panelId) activeButton.after($(panelId));
      else if (Object.hasOwn(objectRotations, nextTool)) activeButton.after($('objectControls'));
      else if (EXTRA_TYPES.includes(nextTool)) activeButton.after($('fixtureControls'));
    }
    for (const button of toolButtons) {
      const selected = button.dataset.tool === nextTool;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-pressed', String(selected));
    }
    $('selectControls').hidden = tool !== 'select';
    $('measureControls').hidden = tool !== 'measure';
    updateMeasureControls();
    $('objectControls').hidden = !Object.hasOwn(objectRotations, tool);
    $('fixtureControls').hidden = !EXTRA_TYPES.includes(tool) || Object.hasOwn(objectRotations,tool);
    $('fixtureHelp').textContent=HINTS[tool] || '';
    updateObjectControls();
    $('boundaryControls').hidden = tool !== 'boundary';
    $('hintText').textContent = HINTS[tool];
    updateCursor();
    requestDraw();
  }

  function resetMeasurement() {
    measurement = null;
    measurementContext = `${workspace.activeProjectId}:${state.activeFloorId}`;
    updateMeasureControls();
    requestDraw();
  }

  function measurementInfo(value) {
    const dx = Math.abs(value.end.x - value.start.x);
    const dy = Math.abs(value.end.y - value.start.y);
    if (value.type === 'area') {
      const width = dx + 1, depth = dy + 1;
      return { title: `${width} × ${depth} blocks`, subtitle: `${width * depth} blocks² of floor area`, badge: `${width} × ${depth} · ${width * depth} blocks²` };
    }
    if (dx === 0 || dy === 0) {
      const length = Math.max(dx, dy) + 1;
      return { title: `${length} block${length === 1 ? '' : 's'}`, subtitle: `${dx} blocks across · ${dy} blocks down (endpoints included)`, badge: `${length} block${length === 1 ? '' : 's'}` };
    }
    const length = Math.hypot(dx, dy);
    return { title: `${length.toFixed(2)} blocks`, subtitle: `Diagonal (centre to centre) · ΔX ${dx}, ΔZ ${dy}`, badge: `${length.toFixed(2)} blocks` };
  }

  function updateMeasureControls() {
    const active = gesture?.mode === 'measure' ? { start: gesture.start, end: gesture.current, type: gesture.measureType } : measurement;
    const info = active ? measurementInfo(active) : null;
    $('measureResult').textContent = info?.title || 'Ready to measure';
    $('measureDetails').textContent = info?.subtitle || (measureMode === 'line' ? 'Drag between two grid squares.' : 'Drag across a room to measure its floor area.');
    $('clearMeasure').disabled = !active;
    for (const button of document.querySelectorAll('[data-measure-mode]')) {
      const selected = button.dataset.measureMode === measureMode;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-pressed', String(selected));
    }
  }

  function updateObjectControls() {
    if (!Object.hasOwn(objectRotations, tool)) return;
    const names = { door: 'Door', window: 'Window', bed: 'Bed', stairs: 'Stairs', shower: 'Shower', toilet: 'Toilet', sink: 'Sink', furnace: 'Furnace', fridge: 'Fridge', chair: 'Chair' };
    $('objectHeading').textContent = `${names[tool]} orientation`;
    $('objectAngle').textContent = `${objectRotations[tool] * 90}°`;
    if (EXTRA_TYPES.includes(tool)) { $('objectHelp').textContent = tool === 'shower' ? 'A shower occupies three squares in an L shape. Press R to rotate it.' : 'This fixture occupies one square. Press R to change its orientation.'; return; }
    $('objectHelp').textContent = tool === 'bed'
      ? 'Beds use 1 × 2 squares. The pillow is at the head. Click an existing bed to rotate it, or press R to change the placement angle.'
      : tool === 'stairs'
        ? 'Click or drag to mark a staircase. Lines show the steps, and the arrow shows the facing direction. Click a stair to rotate it.'
        : tool === 'window'
          ? 'Click for a single glass pane, or drag to replace a row of blocks with windows. Runs align automatically. Press R to rotate single windows, or click an existing window to rotate it.'
          : 'Click an existing door to rotate it. New doors use the selected angle.';
  }

  function rotateActiveObject() {
    if (!Object.hasOwn(objectRotations, tool)) return;
    objectRotations[tool] = (objectRotations[tool] + 1) % 4;
    updateObjectControls();
    requestDraw();
  }

  function updateCursor() {
    canvas.style.cursor = gesture?.mode === 'pan' ? 'grabbing' : (spaceDown || tool === 'pan') ? 'grab' : gesture?.mode === 'move-selection' ? 'grabbing' : (tool === 'select' && selection && hovered && insideRect(hovered, selection.bounds)) ? 'move' : tool === 'erase' ? 'cell' : 'crosshair';
  }

  function nextFloorName() {
    let n = 1;
    while (state.floors.some(floor => floor.name === `Floor ${n}`)) n++;
    return `Floor ${n}`;
  }

  function addFloor(copy) {
    clearSelection();
    if (state.floors.length >= MAX_FLOORS) { showToast('Maximum of 20 floors per project.'); return; }
    const name = nextFloorName();
    change(() => {
      const floor = createFloor(name, copy ? activeFloor() : null);
      state.floors.push(floor);
      state.activeFloorId = floor.id;
    });
    showToast(copy ? `${name} created from the current floor` : `${name} created as a blank floor`);
  }

  function renameFloor(id) {
    const floor = state.floors.find(entry => entry.id === id);
    if (!floor) return;
    openModal({ title: 'Rename floor', description: 'Give this level a name that is easy to recognise.', button: 'Rename', fields: [{ name: 'name', label: 'Floor name', value: floor.name, maxLength: 40 }], onSubmit: values => change(() => { floor.name = values.name.trim(); }) });
  }

  function removeFloor(id) {
    if (state.floors.length === 1) { showToast('A project needs at least one floor.'); return; }
    const floor = state.floors.find(entry => entry.id === id);
    if (!floor || !confirm(`Delete "${floor.name}"? You can undo this action.`)) return;
    clearSelection();
    change(() => {
      const index = state.floors.findIndex(entry => entry.id === id);
      state.floors.splice(index, 1);
      if (state.activeFloorId === id) state.activeFloorId = state.floors[Math.min(index, state.floors.length - 1)].id;
    });
  }

  function updateUI() {
    if (measurementContext !== `${workspace.activeProjectId}:${state.activeFloorId}`) resetMeasurement();
    const index = activeIndex();
    const floor = activeFloor();
    renderBuildTabs();
    $('floorCount').textContent = `${index + 1} / ${state.floors.length}`;
    $('activeFloorHeading').textContent = floor.name;
    $('floorIndexTag').textContent = `LEVEL ${String(index + 1).padStart(2, '0')}`;
    $('gridDimensions').textContent = `${state.cols} × ${state.rows}`;
    $('undo').disabled = undoStack.length === 0;
    $('redo').disabled = redoStack.length === 0;
    updateObjectControls();
    $('clearBoundary').disabled = !floor.boundary;
    $('showBelow').disabled = index === 0;
    $('showBelow').checked = showBelow;
    $('zoomValue').textContent = `${Math.round(view.size / 24 * 100)}%`;
    const list = $('floorList');
    list.replaceChildren();
    state.floors.forEach((entry, i) => {
      const row = document.createElement('div');
      row.className = `floor-row${entry.id === floor.id ? ' selected' : ''}`;
      const switcher = document.createElement('button');
      switcher.type = 'button';
      switcher.className = 'floor-switch';
      switcher.setAttribute('aria-label', `Switch to ${entry.name}`);
      switcher.innerHTML = '<span class="floor-visual"><svg class="icon"><use href="#i-layers"></use></svg></span>';
      const info = document.createElement('span');
      info.style.minWidth = '0';
      const name = document.createElement('span');
      name.className = 'floor-name';
      name.textContent = entry.name;
      const detail = document.createElement('span');
      detail.className = 'floor-detail';
      detail.textContent = `${Object.keys(entry.blocks).length} blocks · ${Object.keys(entry.doors).length} doors · ${Object.keys(entry.windows).length} windows · ${Object.keys(entry.beds).length} beds · ${Object.keys(entry.stairs).length} stairs · ${Object.keys(entry.fixtures || {}).length} fixtures`;
      info.append(name, detail);
      switcher.append(info);
      switcher.addEventListener('click', () => { clearSelection(); state.activeFloorId = entry.id; save(); updateUI(); requestDraw(); });
      switcher.addEventListener('dblclick', () => renameFloor(entry.id));
      const rename = document.createElement('button');
      rename.type = 'button'; rename.className = 'floor-mini-action'; rename.title = `Rename ${entry.name}`;
      rename.setAttribute('aria-label', `Rename ${entry.name}`);
      rename.innerHTML = '<svg class="icon"><use href="#i-edit"></use></svg>';
      rename.addEventListener('click', () => renameFloor(entry.id));
      const remove = document.createElement('button');
      remove.type = 'button'; remove.className = 'floor-mini-action'; remove.title = `Delete ${entry.name}`;
      remove.setAttribute('aria-label', `Delete ${entry.name}`);
      remove.innerHTML = '<svg class="icon"><use href="#i-trash"></use></svg>';
      remove.disabled = state.floors.length < 2;
      remove.addEventListener('click', () => removeFloor(entry.id));
      row.append(switcher, rename, remove);
      list.appendChild(row);
    });
    updateStats();
  }

  function updateStats() {
    const floor = activeFloor();
    $('floorStats').textContent = `${Object.keys(floor.blocks).length} blocks · ${Object.keys(floor.doors).length} doors · ${Object.keys(floor.windows).length} windows · ${Object.keys(floor.beds).length} beds · ${Object.keys(floor.stairs).length} stairs · ${Object.keys(floor.fixtures || {}).length} fixtures · ${floor.labels.length} labels`;
    const b = floor.boundary;
    $('boundaryStats').textContent = b ? `Boundary ${b.x2 - b.x1 + 1} × ${b.y2 - b.y1 + 1}` : 'No boundary set';
    $('zoomValue').textContent = `${Math.round(view.size / 24 * 100)}%`;
  }

  function openModal({ title, description, fields, button, onSubmit }) {
    modalCallback = onSubmit;
    $('modalTitle').textContent = title;
    $('modalDescription').textContent = description;
    $('confirmModal').textContent = button || 'Save';
    const container = $('modalFields');
    container.replaceChildren();
    fields.forEach(field => {
      const wrapper = document.createElement('label');
      wrapper.className = 'modal-field';
      wrapper.textContent = field.label;
      const input = document.createElement('input');
      input.name = field.name;
      input.type = field.type || 'text';
      input.required = true;
      input.value = field.value;
      if (field.min !== undefined) input.min = field.min;
      if (field.max !== undefined) input.max = field.max;
      if (field.maxLength) input.maxLength = field.maxLength;
      wrapper.append(input);
      container.append(wrapper);
    });
    $('editorDialog').showModal();
    container.querySelector('input')?.focus();
    container.querySelector('input')?.select();
  }

  function editLabel(cell) {
    const existing = activeFloor().labels.find(label => label.x === cell.x && label.y === cell.y);
    openModal({
      title: existing ? 'Edit room label' : 'Add room label',
      description: `This label is only an annotation, it does not place any Minecraft blocks. Cell ${cell.x + 1}, ${cell.y + 1}.`,
      button: existing ? 'Update label' : 'Add label',
      fields: [{ name: 'name', label: 'Room name', value: existing?.text || '', maxLength: 50 }],
      onSubmit: values => change(() => {
        if (existing) existing.text = values.name.trim();
        else activeFloor().labels.push({ id: makeId(), x: cell.x, y: cell.y, text: values.name.trim() });
      })
    });
  }

  $('modalForm').addEventListener('submit', event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    if (Object.values(values).some(value => String(value).trim() === '')) return;
    try {
      if (modalCallback?.(values) !== false) $('editorDialog').close();
    } catch (error) { showToast(error.message || 'Could not update this value.'); }
  });
  $('cancelModal').addEventListener('click', () => $('editorDialog').close());
  $('editorDialog').addEventListener('close', () => {
    // The close event can fire after a second dialog has already opened.
    if (!$('editorDialog').open) { modalCallback = null; canvas.focus({ preventScroll: true }); }
  });

  function inBounds(cell) { return cell && cell.x >= 0 && cell.y >= 0 && cell.x < state.cols && cell.y < state.rows; }
  function getCell(event, limit = false) {
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((event.clientX - rect.left - view.x) / view.size);
    const y = Math.floor((event.clientY - rect.top - view.y) / view.size);
    const point = { x, y };
    if (limit) return { x: clamp(x, 0, state.cols - 1), y: clamp(y, 0, state.rows - 1) };
    return inBounds(point) ? point : null;
  }
  function pointerPosition(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }
  function lineCells(a, b, axis = false) {
    if (axis) {
      b = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
    }
    const result = [];
    let x = a.x, y = a.y;
    const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y);
    const sx = x < b.x ? 1 : -1, sy = y < b.y ? 1 : -1;
    let error = dx - dy;
    while (true) {
      result.push({ x, y });
      if (x === b.x && y === b.y) break;
      const e2 = error * 2;
      if (e2 > -dy) { error -= dy; x += sx; }
      if (e2 < dx) { error += dx; y += sy; }
    }
    return result;
  }
  // 0 = facing north (up), 1 = east, 2 = south, 3 = west.
  function bedCells(anchor, rotation) {
    const directions = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    const [dx, dy] = directions[rotation];
    return [anchor, { x: anchor.x + dx, y: anchor.y + dy }];
  }
  function bedAtCell(floor, cell) {
    for (const [key, rotation] of Object.entries(floor.beds)) {
      const [x, y] = readKey(key);
      if (bedCells({ x, y }, rotation).some(point => point.x === cell.x && point.y === cell.y)) return { key, anchor: { x, y }, rotation };
    }
    return null;
  }
  function fixtureCells(anchor, fixture) {
    if (fixture.type !== 'shower') return [anchor];
    const patterns = [[[0,0],[1,0],[0,1]], [[0,0],[0,1],[-1,0]], [[0,0],[-1,0],[0,-1]], [[0,0],[0,-1],[1,0]]];
    return patterns[fixture.rotation % 4].map(([dx,dy]) => ({x:anchor.x+dx,y:anchor.y+dy}));
  }
  function fixtureAtCell(floor, cell) {
    for (const [key, fixture] of Object.entries(floor.fixtures || {})) {
      const [x,y] = readKey(key);
      if (fixtureCells({x,y}, fixture).some(c => c.x===cell.x && c.y===cell.y)) return {key, fixture};
    }
    return null;
  }
  function placeFixture(floor, anchor, fixture, dimensions = state) {
    const cells=fixtureCells(anchor, fixture);
    if (!cells.every(c => c.x>=0 && c.y>=0 && c.x<dimensions.cols && c.y<dimensions.rows)) return false;
    clearOccupants(floor, cells);
    floor.fixtures[cellKey(anchor.x,anchor.y)]={type:fixture.type,rotation:fixture.rotation};
    return true;
  }
  function clearOccupants(floor, cells) {
    // Erasing any half of a bed removes the whole bed, so no broken beds remain.
    const overlap = new Set();
    const fixtureOverlap = new Set();
    for (const cell of cells) {
      const key = cellKey(cell.x, cell.y);
      delete floor.blocks[key];
      delete floor.doors[key];
      delete floor.windows[key];
      delete floor.stairs[key];
      const bed = bedAtCell(floor, cell);
      if (bed) overlap.add(bed.key);
      const fixture = fixtureAtCell(floor, cell);
      if (fixture) fixtureOverlap.add(fixture.key);
    }
    for (const key of overlap) delete floor.beds[key];
    for (const key of fixtureOverlap) delete floor.fixtures[key];
  }
  function placeBlock(floor, cell) {
    clearOccupants(floor, [cell]);
    floor.blocks[cellKey(cell.x, cell.y)] = true;
  }
  function placeDoor(floor, cell, rotation) {
    clearOccupants(floor, [cell]);
    floor.doors[cellKey(cell.x, cell.y)] = rotation;
  }
  function placeWindow(floor, cell, rotation) {
    clearOccupants(floor, [cell]);
    floor.windows[cellKey(cell.x, cell.y)] = rotation;
  }
  function windowRunRotation(start, end) {
    if (start.x === end.x && start.y === end.y) return objectRotations.window;
    return Math.abs(end.x - start.x) >= Math.abs(end.y - start.y) ? 0 : 1;
  }
  function placeStair(floor, cell, rotation) {
    clearOccupants(floor, [cell]);
    floor.stairs[cellKey(cell.x, cell.y)] = rotation;
  }
  function placeBed(floor, anchor, rotation, dimensions = state) {
    const cells = bedCells(anchor, rotation);
    // A complete two-block bed must fit on the board.
    if (!cells.every(cell => cell.x >= 0 && cell.y >= 0 && cell.x < dimensions.cols && cell.y < dimensions.rows)) return false;
    clearOccupants(floor, cells);
    floor.beds[cellKey(anchor.x, anchor.y)] = rotation;
    return true;
  }
  function putCell(cell, erase) {
    if (!inBounds(cell)) return;
    const floor = activeFloor();
    if (erase) {
      clearOccupants(floor, [cell]);
      floor.labels = floor.labels.filter(label => label.x !== cell.x || label.y !== cell.y);
    } else placeBlock(floor, cell);
  }
  function perimeterCells(a, b) {
    const rect = makeBoundary(a, b);
    const cells = [];
    for (let x = rect.x1; x <= rect.x2; x++) {
      cells.push({ x, y: rect.y1 });
      if (rect.y2 !== rect.y1) cells.push({ x, y: rect.y2 });
    }
    for (let y = rect.y1 + 1; y < rect.y2; y++) {
      cells.push({ x: rect.x1, y });
      if (rect.x2 !== rect.x1) cells.push({ x: rect.x2, y });
    }
    return cells;
  }
  function makeBoundary(start, end) {
    return { x1: Math.min(start.x, end.x), y1: Math.min(start.y, end.y), x2: Math.max(start.x, end.x), y2: Math.max(start.y, end.y) };
  }

  function insideRect(cell, bounds) {
    return cell.x >= bounds.x1 && cell.x <= bounds.x2 && cell.y >= bounds.y1 && cell.y <= bounds.y2;
  }

  function updateSelectionUI() {
    $('selectionDetail').textContent = selection ? `${selection.blockKeys.length} blocks · ${selection.doorKeys.length} doors · ${selection.windowKeys.length} windows · ${selection.bedKeys.length} beds · ${selection.stairKeys.length} stairs · ${selection.fixtureKeys.length} fixtures · ${selection.labelIds.length} labels` : 'Nothing selected';
    $('clearSelection').disabled = !selection;
  }

  function clearSelection() {
    selection = null;
    updateSelectionUI();
    updateCursor();
    requestDraw();
  }

  function selectArea(bounds) {
    const floor = activeFloor();
    const blockKeys = Object.keys(floor.blocks).filter(key => { const [x, y] = readKey(key); return insideRect({ x, y }, bounds); });
    const doorKeys = Object.keys(floor.doors).filter(key => { const [x, y] = readKey(key); return insideRect({ x, y }, bounds); });
    const windowKeys = Object.keys(floor.windows).filter(key => { const [x, y] = readKey(key); return insideRect({ x, y }, bounds); });
    const stairKeys = Object.keys(floor.stairs).filter(key => { const [x, y] = readKey(key); return insideRect({ x, y }, bounds); });
    const bedKeys = Object.keys(floor.beds).filter(key => { const [x, y] = readKey(key); return bedCells({ x, y }, floor.beds[key]).some(cell => insideRect(cell, bounds)); });
    const fixtureKeys = Object.keys(floor.fixtures || {}).filter(key => { const [x,y]=readKey(key); return fixtureCells({x,y},floor.fixtures[key]).some(cell=>insideRect(cell,bounds)); });
    const labelIds = floor.labels.filter(label => insideRect(label, bounds)).map(label => label.id);
    // If a bed's head alone was selected, include the whole bed in the move boundary.
    const selectionBounds = { ...bounds };
    for (const key of bedKeys) {
      const [x, y] = readKey(key);
      for (const cell of bedCells({ x, y }, floor.beds[key])) {
        selectionBounds.x1 = Math.min(selectionBounds.x1, cell.x);
        selectionBounds.y1 = Math.min(selectionBounds.y1, cell.y);
        selectionBounds.x2 = Math.max(selectionBounds.x2, cell.x);
        selectionBounds.y2 = Math.max(selectionBounds.y2, cell.y);
      }
    }
    for (const key of fixtureKeys) {
      const [x,y]=readKey(key);
      for (const c of fixtureCells({x,y},floor.fixtures[key])) {
        selectionBounds.x1=Math.min(selectionBounds.x1,c.x); selectionBounds.y1=Math.min(selectionBounds.y1,c.y);
        selectionBounds.x2=Math.max(selectionBounds.x2,c.x); selectionBounds.y2=Math.max(selectionBounds.y2,c.y);
      }
    }
    selection = fixtureKeys.length || blockKeys.length || doorKeys.length || windowKeys.length || bedKeys.length || stairKeys.length || labelIds.length
      ? { bounds: selectionBounds, blockKeys, doorKeys, windowKeys, bedKeys, stairKeys, fixtureKeys, labelIds } : null;
    updateSelectionUI();
    updateCursor();
  }

  function moveDelta(start, next) {
    const bounds = selection.bounds;
    return {
      dx: clamp(next.x - start.x, -bounds.x1, state.cols - 1 - bounds.x2),
      dy: clamp(next.y - start.y, -bounds.y1, state.rows - 1 - bounds.y2)
    };
  }

  function translateBounds(bounds, dx, dy) {
    return { x1: bounds.x1 + dx, y1: bounds.y1 + dy, x2: bounds.x2 + dx, y2: bounds.y2 + dy };
  }

  function moveSelectedItems(dx, dy) {
    if (!selection || (!dx && !dy)) return false;
    const floor = activeFloor();
    const blocks = selection.blockKeys.filter(key => floor.blocks[key]).map(key => readKey(key));
    const doors = selection.doorKeys.filter(key => Object.hasOwn(floor.doors, key)).map(key => ({ cell: readKey(key), rotation: floor.doors[key] }));
    const windows = selection.windowKeys.filter(key => Object.hasOwn(floor.windows, key)).map(key => ({ cell: readKey(key), rotation: floor.windows[key] }));
    const stairs = selection.stairKeys.filter(key => Object.hasOwn(floor.stairs, key)).map(key => ({ cell: readKey(key), rotation: floor.stairs[key] }));
    const beds = selection.bedKeys.filter(key => Object.hasOwn(floor.beds, key)).map(key => ({ cell: readKey(key), rotation: floor.beds[key] }));
    const fixtures = selection.fixtureKeys.map(key=>({cell:readKey(key),fixture:{...floor.fixtures[key]}}));
    const ids = new Set(selection.labelIds);
    const labels = floor.labels.filter(label => ids.has(label.id));

    // Clear the entire source group before placing anything so overlapping moves stay intact.
    for (const key of selection.blockKeys) delete floor.blocks[key];
    for (const key of selection.doorKeys) delete floor.doors[key];
    for (const key of selection.windowKeys) delete floor.windows[key];
    for (const key of selection.stairKeys) delete floor.stairs[key];
    for (const key of selection.bedKeys) delete floor.beds[key];
    for (const key of selection.fixtureKeys) delete floor.fixtures[key];
    for (const [x, y] of blocks) placeBlock(floor, { x: x + dx, y: y + dy });
    for (const { cell: [x, y], rotation } of doors) placeDoor(floor, { x: x + dx, y: y + dy }, rotation);
    for (const { cell: [x, y], rotation } of windows) placeWindow(floor, { x: x + dx, y: y + dy }, rotation);
    for (const { cell: [x, y], rotation } of stairs) placeStair(floor, { x: x + dx, y: y + dy }, rotation);
    for (const { cell: [x, y], rotation } of beds) placeBed(floor, { x: x + dx, y: y + dy }, rotation);
    for (const {cell:[x,y],fixture} of fixtures) placeFixture(floor,{x:x+dx,y:y+dy},fixture);
    for (const label of labels) { label.x += dx; label.y += dy; }

    selection = {
      bounds: translateBounds(selection.bounds, dx, dy),
      blockKeys: blocks.map(([x, y]) => cellKey(x + dx, y + dy)),
      doorKeys: doors.map(({ cell: [x, y] }) => cellKey(x + dx, y + dy)),
      windowKeys: windows.map(({ cell: [x, y] }) => cellKey(x + dx, y + dy)),
      stairKeys: stairs.map(({ cell: [x, y] }) => cellKey(x + dx, y + dy)),
      bedKeys: beds.map(({ cell: [x, y] }) => cellKey(x + dx, y + dy)),
      fixtureKeys: fixtures.map(({cell:[x,y]})=>cellKey(x+dx,y+dy)),
      labelIds: [...selection.labelIds]
    };
    updateSelectionUI();
    return true;
  }

  function deleteSelection() {
    if (!selection) return;
    change(() => {
      const floor = activeFloor();
      for (const key of selection.blockKeys) delete floor.blocks[key];
      for (const key of selection.doorKeys) delete floor.doors[key];
      for (const key of selection.windowKeys) delete floor.windows[key];
      for (const key of selection.stairKeys) delete floor.stairs[key];
      for (const key of selection.bedKeys) delete floor.beds[key];
      for (const key of selection.fixtureKeys) delete floor.fixtures[key];
      const labels = new Set(selection.labelIds);
      floor.labels = floor.labels.filter(label => !labels.has(label.id));
    });
    clearSelection();
  }

  function updateWallMeasure(event) {
    const badge = $('wallMeasure');
    if (!gesture || !['wall', 'rectangle', 'window', 'measure', 'bath', 'table', 'counter'].includes(gesture.mode)) { badge.hidden = true; return; }
    if (gesture.mode === 'measure') {
      badge.textContent = measurementInfo({ type: gesture.measureType, start: gesture.start, end: gesture.current }).badge;
    } else if (['rectangle','bath','table'].includes(gesture.mode)) {
      const bounds = makeBoundary(gesture.start, gesture.current);
      badge.textContent = `${bounds.x2 - bounds.x1 + 1} × ${bounds.y2 - bounds.y1 + 1} blocks`;
    } else {
      const distance = lineCells(gesture.start, gesture.current, true).length;
      badge.textContent = `${distance} ${gesture.mode === 'window' ? 'window' : gesture.mode === 'counter' ? 'counter' : 'block'}${distance === 1 ? '' : 's'}`;
    }
    badge.hidden = false;
    const point = pointerPosition(event);
    // Place beside the cursor without clipping against the viewport edge.
    const x = clamp(point.x + 17, 4, Math.max(4, canvasWidth - badge.offsetWidth - 10));
    const y = clamp(point.y - 37, 4, Math.max(4, canvasHeight - 32));
    badge.style.transform = `translate(${x}px, ${y}px)`;
  }

  function pointerDown(event) {
    if (event.button !== 0 && event.button !== 1 && event.button !== 2) return;
    if ($('editorDialog').open) return;
    const pan = event.button === 1 || spaceDown || (event.button === 0 && tool === 'pan');
    if (pan) {
      event.preventDefault();
      const point = pointerPosition(event);
      gesture = { mode: 'pan', start: point, x: view.x, y: view.y };
      canvas.setPointerCapture(event.pointerId);
      updateCursor();
      return;
    }
    const cell = getCell(event);
    if (!cell) return;
    event.preventDefault();
    canvas.focus({ preventScroll: true });
    if (tool === 'select' && event.button === 0) {
      if (selection && insideRect(cell, selection.bounds)) {
        gesture = { mode: 'move-selection', start: cell, current: cell, delta: { dx: 0, dy: 0 }, before: snapshot() };
      } else {
        selection = null;
        updateSelectionUI();
        gesture = { mode: 'select', start: cell, current: cell };
      }
      canvas.setPointerCapture(event.pointerId);
      updateCursor();
      requestDraw();
      return;
    }
    if (tool === 'measure') {
      // Right click must never erase while using this non-destructive tool.
      if (event.button !== 0) return;
      gesture = { mode: 'measure', measureType: measureMode, start: cell, current: cell };
      canvas.setPointerCapture(event.pointerId);
      updateMeasureControls();
      updateWallMeasure(event);
      requestDraw();
      return;
    }
    if (tool === 'label' && event.button === 0) { editLabel(cell); return; }
    if (tool === 'door' && event.button === 0) {
      change(() => {
        const key = cellKey(cell.x, cell.y);
        const floor = activeFloor();
        const rotation = Object.hasOwn(floor.doors, key) ? (floor.doors[key] + 1) % 4 : objectRotations.door;
        placeDoor(floor, cell, rotation);
      });
      return;
    }
    if (tool === 'bed' && event.button === 0) {
      const floor = activeFloor();
      const existing = bedAtCell(floor, cell);
      const anchor = existing?.anchor || cell;
      const rotation = existing ? (existing.rotation + 1) % 4 : objectRotations.bed;
      const cells = bedCells(anchor, rotation);
      if (!cells.every(inBounds)) { showToast('Bed needs two blocks inside the grid. Rotate with R or choose another cell.'); return; }
      change(() => {
        if (existing) delete floor.beds[existing.key];
        placeBed(floor, anchor, rotation);
      });
      return;
    }
    if (EXTRA_TYPES.includes(tool) && !RECT_FIXTURES.includes(tool) && !LINE_FIXTURES.includes(tool) && event.button === 0) {
      if (tool === 'shower') {
        const existing=fixtureAtCell(activeFloor(),cell);
        const same=existing?.fixture.type==='shower';
        const [ax,ay]=same?readKey(existing.key):[cell.x,cell.y];
        const anchor={x:ax,y:ay};
        const rotation=same?(existing.fixture.rotation+1)%4:objectRotations.shower;
        if (!fixtureCells(anchor,{type:'shower',rotation}).every(inBounds)) {showToast('The three shower blocks need to fit on the grid.');return;}
        change(()=>{if(same)delete activeFloor().fixtures[existing.key];placeFixture(activeFloor(),anchor,{type:'shower',rotation});});
      } else change(()=>placeFixture(activeFloor(),cell,{type:tool,rotation:objectRotations[tool]||0}));
      return;
    }
    const mode = event.button === 2 ? 'erase' : tool;
    if (selection) clearSelection();
    gesture = { mode, start: cell, last: cell, current: cell, before: snapshot() };
    canvas.setPointerCapture(event.pointerId);
    if (mode === 'block' || mode === 'erase') putCell(cell, mode === 'erase');
    if (mode === 'stairs') {
      const floor = activeFloor();
      const key = cellKey(cell.x, cell.y);
      const rotation = Object.hasOwn(floor.stairs, key) ? (floor.stairs[key] + 1) % 4 : objectRotations.stairs;
      placeStair(floor, cell, rotation);
    }
    updateStats();
    updateWallMeasure(event);
    requestDraw();
  }

  function pointerMove(event) {
    const cell = getCell(event);
    hovered = cell;
    $('cursorPosition').textContent = cell ? `CELL: ${cell.x + 1}, ${cell.y + 1}` : 'CELL: −, −';
    if (gesture?.mode === 'pan') {
      const point = pointerPosition(event);
      view.x = gesture.x + point.x - gesture.start.x;
      view.y = gesture.y + point.y - gesture.start.y;
    } else if (gesture) {
      const next = getCell(event, true);
      if (next) {
        if (gesture.mode === 'block' || gesture.mode === 'erase' || gesture.mode === 'stairs') {
          for (const point of lineCells(gesture.last, next)) {
            if (gesture.mode === 'stairs') {
              if (cellKey(point.x, point.y) !== cellKey(gesture.start.x, gesture.start.y)) placeStair(activeFloor(), point, objectRotations.stairs);
            } else putCell(point, gesture.mode === 'erase');
          }
          gesture.last = next;
          updateStats();
        }
        gesture.current = next;
        if (gesture.mode === 'move-selection') gesture.delta = moveDelta(gesture.start, next);
      }
    }
    updateWallMeasure(event);
    if (gesture?.mode === 'measure') updateMeasureControls();
    updateCursor();
    requestDraw();
  }

  function pointerUp(event) {
    if (!gesture) return;
    const done = gesture;
    // Finalize using the release position, even if the browser missed the last move.
    const last = getCell(event, true) || done.current;
    gesture = null;
    if (done.mode === 'measure') {
      if (last) measurement = { type: done.measureType, start: done.start, end: last };
      updateMeasureControls();
    } else if (done.mode === 'wall') {
      if (last) for (const cell of lineCells(done.start, last, true)) putCell(cell, false);
    } else if (done.mode === 'rectangle') {
      if (last) for (const cell of perimeterCells(done.start, last)) putCell(cell, false);
    } else if (done.mode === 'window') {
      if (last) {
        const floor = activeFloor();
        const cells = lineCells(done.start, last, true);
        if (cells.length === 1 && Object.hasOwn(floor.windows, cellKey(done.start.x, done.start.y))) {
          const key = cellKey(done.start.x, done.start.y);
          floor.windows[key] = (floor.windows[key] + 1) % 4;
        } else {
          const rotation = windowRunRotation(done.start, last);
          for (const cell of cells) placeWindow(floor, cell, rotation);
        }
      }
    } else if (RECT_FIXTURES.includes(done.mode)) {
      if(last) {
        const bounds=makeBoundary(done.start,last);
        for(let row=bounds.y1;row<=bounds.y2;row++) for(let col=bounds.x1;col<=bounds.x2;col++) placeFixture(activeFloor(),{x:col,y:row},{type:done.mode,rotation:0});
      }
    } else if (done.mode === 'counter') {
      if(last) for(const cell of lineCells(done.start,last,true)) placeFixture(activeFloor(),cell,{type:'counter',rotation:0});
    } else if (done.mode === 'boundary') {
      if (last) activeFloor().boundary = makeBoundary(done.start, last);
    } else if (done.mode === 'select') {
      if (last) selectArea(makeBoundary(done.start, last));
    } else if (done.mode === 'move-selection') {
      if (last) { const delta = moveDelta(done.start, last); moveSelectedItems(delta.dx, delta.dy); }
    }
    if (done.before) remember(done.before);
    $('wallMeasure').hidden = true;
    updateCursor();
    requestDraw();
  }

  function pointerCancel() {
    if (!gesture) return;
    const done = gesture;
    gesture = null;
    if (done.before) state = JSON.parse(done.before);
    $('wallMeasure').hidden = true;
    updateMeasureControls();
    updateStats(); updateCursor(); requestDraw();
  }

  canvas.addEventListener('pointerdown', pointerDown);
  canvas.addEventListener('pointermove', pointerMove);
  canvas.addEventListener('pointerup', pointerUp);
  canvas.addEventListener('pointercancel', pointerCancel);
  canvas.addEventListener('pointerleave', () => { if (!gesture) { hovered = null; $('cursorPosition').textContent = 'CELL: −, −'; requestDraw(); } });
  canvas.addEventListener('contextmenu', event => event.preventDefault());

  // Drawing coordinates and camera controls.
  function requestDraw() {
    if (framePending) return;
    framePending = true;
    requestAnimationFrame(() => { framePending = false; draw(); });
  }
  function resizeCanvas() {
    const w = viewport.clientWidth || 1;
    const h = viewport.clientHeight || 1;
    const prevW = canvasWidth, prevH = canvasHeight;
    canvasWidth = w; canvasHeight = h;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!viewReady) fitView();
    else { view.x += (w - prevW) / 2; view.y += (h - prevH) / 2; }
    requestDraw();
  }
  function fitView() {
    view.size = clamp(Math.min((canvasWidth - 100) / state.cols, (canvasHeight - 105) / state.rows), 8, 36);
    view.x = (canvasWidth - state.cols * view.size) / 2;
    view.y = (canvasHeight - state.rows * view.size) / 2;
    viewReady = true;
    updateStats();
    requestDraw();
  }
  function setZoom(factor, anchorX = canvasWidth / 2, anchorY = canvasHeight / 2) {
    const next = clamp(view.size * factor, 7, 72);
    const ratio = next / view.size;
    view.x = anchorX - (anchorX - view.x) * ratio;
    view.y = anchorY - (anchorY - view.y) * ratio;
    view.size = next;
    updateStats();
    requestDraw();
  }
  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    const point = pointerPosition(event);
    setZoom(event.deltaY < 0 ? 1.12 : 1 / 1.12, point.x, point.y);
  }, { passive: false });
  const ro = new ResizeObserver(resizeCanvas);
  ro.observe(viewport);

  function roundedRect(context, x, y, w, h, radius) {
    const r = Math.min(radius, w / 2, h / 2);
    context.beginPath();
    context.moveTo(x + r, y);
    context.lineTo(x + w - r, y);
    context.quadraticCurveTo(x + w, y, x + w, y + r);
    context.lineTo(x + w, y + h - r);
    context.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    context.lineTo(x + r, y + h);
    context.quadraticCurveTo(x, y + h, x, y + h - r);
    context.lineTo(x, y + r);
    context.quadraticCurveTo(x, y, x + r, y);
    context.closePath();
  }
  function drawDoor(context, x, y, size, rotation, alpha = 1) {
    context.save();
    context.globalAlpha *= alpha;
    context.fillStyle = '#ffffff';
    context.fillRect(x + .7, y + .7, size - 1.4, size - 1.4);
    context.strokeStyle = '#232b2b';
    context.lineWidth = Math.max(1.2, size * .075);
    context.strokeRect(x + 1.2, y + 1.2, size - 2.4, size - 2.4);
    context.translate(x + size / 2, y + size / 2);
    context.rotate(rotation * Math.PI / 2);
    context.beginPath();
    context.moveTo(-size * .32, size * .30);
    context.lineTo(-size * .32, -size * .32);
    context.strokeStyle = '#26302d';
    context.lineWidth = Math.max(1.8, size * .13);
    context.lineCap = 'round';
    context.stroke();
    context.beginPath();
    context.arc(-size * .32, size * .30, size * .62, -Math.PI / 2, 0, false);
    context.lineWidth = Math.max(.8, size * .045);
    context.strokeStyle = '#88968f';
    context.stroke();
    context.restore();
  }
  function drawWindow(context, x, y, size, rotation, alpha = 1) {
    context.save();
    context.globalAlpha *= alpha;
    context.fillStyle = '#d9f2f5';
    context.fillRect(x + size * .08, y + size * .08, size * .84, size * .84);
    context.translate(x + size / 2, y + size / 2);
    context.rotate(rotation * Math.PI / 2);
    // The thick cyan pane runs through the centre of one Minecraft block.
    context.fillStyle = '#83c9dc';
    context.strokeStyle = '#216982';
    context.lineWidth = Math.max(1, size * .052);
    roundedRect(context, -size * .44, -size * .145, size * .88, size * .29, Math.max(.7, size * .045));
    context.fill(); context.stroke();
    context.strokeStyle = '#e4fbff';
    context.lineWidth = Math.max(.9, size * .075);
    context.beginPath(); context.moveTo(-size * .33, -size * .048); context.lineTo(size * .33, -size * .048); context.stroke();
    context.fillStyle = '#275972';
    context.fillRect(-size * .455, -size * .18, Math.max(1.5, size * .09), size * .36);
    context.fillRect(size * .365, -size * .18, Math.max(1.5, size * .09), size * .36);
    context.restore();
  }
  function drawBed(context, x, y, size, rotation, alpha = 1) {
    context.save();
    context.globalAlpha *= alpha;
    context.translate(x + size / 2, y + size / 2);
    context.rotate(rotation * Math.PI / 2);
    const left = -size * .43, top = -size * 1.43;
    const w = size * .86, h = size * 1.87;
    context.fillStyle = '#afc4d7';
    context.strokeStyle = '#607b96';
    context.lineWidth = Math.max(1, size * .055);
    roundedRect(context, left, top, w, h, Math.max(2, size * .12));
    context.fill(); context.stroke();
    context.fillStyle = '#f5f8fa';
    roundedRect(context, left + size * .075, top + size * .08, w - size * .15, size * .47, size * .11);
    context.fill();
    context.strokeStyle = '#7794af';
    context.lineWidth = Math.max(.75, size * .035);
    context.beginPath(); context.moveTo(left + size * .1, top + size * .67); context.lineTo(left + w - size * .1, top + size * .67); context.stroke();
    context.restore();
  }
  function drawStair(context, x, y, size, rotation, alpha = 1) {
    context.save();
    context.globalAlpha *= alpha;
    context.fillStyle = '#e7eeea';
    context.strokeStyle = '#70877d';
    context.lineWidth = Math.max(1, size * .05);
    context.fillRect(x + size * .09, y + size * .09, size * .82, size * .82);
    context.strokeRect(x + size * .09, y + size * .09, size * .82, size * .82);
    context.translate(x + size / 2, y + size / 2);
    context.rotate(rotation * Math.PI / 2);
    context.strokeStyle = '#748f83';
    context.lineWidth = Math.max(1, size * .065);
    for (const yy of [-.22, 0, .22]) {
      context.beginPath(); context.moveTo(-size * .27, size * yy); context.lineTo(size * .27, size * yy); context.stroke();
    }
    context.fillStyle = '#315f4b';
    context.beginPath();
    context.moveTo(0, -size * .35); context.lineTo(-size * .12, -size * .21); context.lineTo(size * .12, -size * .21); context.closePath(); context.fill();
    context.restore();
  }
  function drawBoundary(context, b, x, y, size, preview = false) {
    if (!b) return;
    const left = x + b.x1 * size, top = y + b.y1 * size;
    const w = (b.x2 - b.x1 + 1) * size, h = (b.y2 - b.y1 + 1) * size;
    context.save();
    context.fillStyle = 'rgba(47, 148, 107, .037)';
    context.fillRect(left, top, w, h);
    context.lineWidth = Math.max(1.5, Math.min(2.2, size * .085));
    context.strokeStyle = preview ? '#43a98a' : '#24826c';
    context.setLineDash([7, 5]);
    context.strokeRect(left, top, w, h);
    context.setLineDash([]);
    context.fillStyle = '#fff';
    const corners = [[left, top], [left + w, top], [left, top + h], [left + w, top + h]];
    for (const [cx, cy] of corners) {
      context.beginPath(); context.arc(cx, cy, 3.1, 0, 2 * Math.PI); context.fill(); context.stroke();
    }
    context.restore();
  }
  function drawSelectionOutline(context, b, x, y, size) {
    if (!b) return;
    const left = x + b.x1 * size, top = y + b.y1 * size;
    const w = (b.x2 - b.x1 + 1) * size, h = (b.y2 - b.y1 + 1) * size;
    context.save();
    context.fillStyle = 'rgba(44, 152, 106, .10)';
    context.fillRect(left, top, w, h);
    context.strokeStyle = '#188f64';
    context.lineWidth = 2.4;
    context.setLineDash([6, 4]);
    context.strokeRect(left + 1, top + 1, w - 2, h - 2);
    context.restore();
  }

  function drawLabels(context, labels, x, y, size) {
    for (const label of labels) {
      const cx = x + (label.x + .5) * size;
      const cy = y + (label.y + .5) * size;
      const fontSize = clamp(size * .55, 10, 14);
      context.font = `700 ${fontSize}px ui-sans-serif, system-ui, sans-serif`;
      const textWidth = context.measureText(label.text).width;
      const w = textWidth + 19;
      const h = fontSize + 13;
      context.save();
      context.fillStyle = 'rgba(255, 255, 255, .97)';
      context.strokeStyle = '#c7d4d1';
      context.lineWidth = 1;
      roundedRect(context, cx - w / 2, cy - h / 2, w, h, 5);
      context.fill(); context.stroke();
      context.fillStyle = '#32413c';
      context.textBaseline = 'middle'; context.textAlign = 'center';
      context.fillText(label.text, cx, cy + .5);
      context.restore();
    }
  }
  function paintBlocks(context, blocks, x, y, size, fill = '#252a2c') {
    context.fillStyle = fill;
    const inset = Math.min(1, size * .08);
    for (const key of Object.keys(blocks)) {
      const [col, row] = readKey(key);
      context.fillRect(x + col * size + inset, y + row * size + inset, Math.max(0, size - inset * 2), Math.max(0, size - inset * 2));
    }
  }

  function drawMeasurement(context, value, x, y, size) {
    if (!value) return;
    const { start, end, type } = value;
    const a = { x: x + (start.x + .5) * size, y: y + (start.y + .5) * size };
    const b = { x: x + (end.x + .5) * size, y: y + (end.y + .5) * size };
    context.save();
    const ink = '#225fbc';
    let labelX = (a.x + b.x) / 2, labelY = (a.y + b.y) / 2 - 23;
    if (type === 'area') {
      const left = x + Math.min(start.x, end.x) * size;
      const top = y + Math.min(start.y, end.y) * size;
      const w = (Math.abs(start.x - end.x) + 1) * size;
      const h = (Math.abs(start.y - end.y) + 1) * size;
      context.fillStyle = 'rgba(49, 111, 213, .13)';
      context.fillRect(left, top, w, h);
      context.strokeStyle = ink;
      context.lineWidth = 2.25;
      context.setLineDash([7, 4]);
      context.strokeRect(left + 1.5, top + 1.5, Math.max(1, w - 3), Math.max(1, h - 3));
      context.setLineDash([]);
      for (const [cx, cy] of [[left, top], [left + w, top], [left, top + h], [left + w, top + h]]) {
        context.fillStyle = '#fff'; context.beginPath(); context.arc(cx, cy, 3.8, 0, Math.PI * 2); context.fill();
        context.strokeStyle = ink; context.stroke();
      }
      labelX = left + w / 2;
      labelY = top + Math.min(h / 2, 43);
    } else {
      context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y);
      context.strokeStyle = '#fff'; context.lineWidth = 6; context.stroke();
      context.strokeStyle = ink; context.lineWidth = 2.5; context.stroke();
      for (const point of [a, b]) {
        context.beginPath(); context.arc(point.x, point.y, 4.5, 0, Math.PI * 2);
        context.fillStyle = '#fff'; context.fill();
        context.lineWidth = 2; context.strokeStyle = ink; context.stroke();
      }
    }
    const label = measurementInfo(value).badge;
    context.font = '750 11px ui-sans-serif, system-ui, sans-serif';
    const labelWidth = context.measureText(label).width + 22;
    const width = state.cols * size, height = state.rows * size;
    labelX = clamp(labelX, x + Math.min(labelWidth / 2 + 2, width / 2), x + width - Math.min(labelWidth / 2 + 2, width / 2));
    labelY = clamp(labelY, y + 16, y + Math.max(16, height - 16));
    context.fillStyle = '#fff';
    context.strokeStyle = '#bdd4f2';
    context.lineWidth = 1.4;
    roundedRect(context, labelX - labelWidth / 2, labelY - 13, labelWidth, 26, 7);
    context.fill(); context.stroke();
    context.fillStyle = ink;
    context.textAlign = 'center'; context.textBaseline = 'middle';
    context.fillText(label, labelX, labelY);
    context.restore();
  }

  const FIXTURE_VISUALS = {
    toilet:['WC','#d5e9eb'], sink:['S','#cce8e9'], shower:['SH','#b2e5eb'], furnace:['F','#e8d6cd'],
    fridge:['FR','#d9e5ee'], bath:['B','#cce8f0'], table:['T','#e9dac5'], chair:['C','#e1d1ad'],counter:['K','#d4dbd3']
  };
  function drawFixture(context,x,y,size,fixture,alpha=1) {
    const [label,color]=FIXTURE_VISUALS[fixture.type] || ['?','#ddd'];
    context.save();context.globalAlpha*=alpha;
    context.fillStyle=color;
    context.fillRect(x+size*.07,y+size*.07,size*.86,size*.86);
    context.strokeStyle='#57717a';context.lineWidth=Math.max(.8,size*.055);
    context.strokeRect(x+size*.12,y+size*.12,size*.76,size*.76);
    context.fillStyle='#27424b';context.textAlign='center';context.textBaseline='middle';
    context.font=`bold ${Math.max(5,Math.min(12,size*.38))}px system-ui`;
    context.fillText(label,x+size*.5,y+size*.53,size*.8);
    context.restore();
  }
  function paintFixtures(context,fixtures,x,y,size,alpha=1,omit=null,dx=0,dy=0) {
    for(const [key,fixture] of Object.entries(fixtures || {})) {
      if(omit?.has(key))continue;
      const [col,row]=readKey(key);
      for(const cell of fixtureCells({x:col,y:row},fixture))drawFixture(context,x+(cell.x+dx)*size,y+(cell.y+dy)*size,size,fixture,alpha);
    }
  }
  function renderBoard(context, x, y, size, options = {}) {
    const width = state.cols * size, height = state.rows * size;
    context.save();
    if (options.shadow) {
      context.shadowColor = 'rgba(38, 47, 50, .11)';
      context.shadowBlur = 25;
      context.shadowOffsetY = 5;
    }
    context.fillStyle = '#fff';
    context.fillRect(x, y, width, height);
    context.restore();
    context.save();
    context.beginPath(); context.rect(x, y, width, height); context.clip();
    // The grid is the only placement surface, with one cell per Minecraft block.
    context.beginPath();
    for (let col = 0; col <= state.cols; col++) { const px = x + col * size + .5; context.moveTo(px, y); context.lineTo(px, y + height); }
    for (let row = 0; row <= state.rows; row++) { const py = y + row * size + .5; context.moveTo(x, py); context.lineTo(x + width, py); }
    context.strokeStyle = '#e9eceb';
    context.lineWidth = 1;
    context.stroke();

    const floor = activeFloor();
    if (options.ghost && activeIndex() > 0) {
      const lower = state.floors[activeIndex() - 1];
      paintBlocks(context, lower.blocks, x, y, size, 'rgba(42, 84, 65, .11)');
      for (const [key, rotation] of Object.entries(lower.doors)) {
        const [col, row] = readKey(key);
        drawDoor(context, x + col * size, y + row * size, size, rotation, .16);
      }
      for (const [key, rotation] of Object.entries(lower.windows)) {
        const [col, row] = readKey(key);
        drawWindow(context, x + col * size, y + row * size, size, rotation, .19);
      }
      for (const [key, rotation] of Object.entries(lower.stairs)) {
        const [col, row] = readKey(key);
        drawStair(context, x + col * size, y + row * size, size, rotation, .21);
      }
      for (const [key, rotation] of Object.entries(lower.beds)) {
        const [col, row] = readKey(key);
        drawBed(context, x + col * size, y + row * size, size, rotation, .22);
      }
    }
    drawBoundary(context, floor.boundary, x, y, size);
    if(options.ghost && activeIndex()>0) paintFixtures(context,state.floors[activeIndex()-1].fixtures,x,y,size,.17);
    const moving = options.preview && gesture?.mode === 'move-selection' && selection;
    const excludedBlocks = moving ? new Set(selection.blockKeys) : null;
    const excludedDoors = moving ? new Set(selection.doorKeys) : null;
    const excludedWindows = moving ? new Set(selection.windowKeys) : null;
    const excludedStairs = moving ? new Set(selection.stairKeys) : null;
    const excludedBeds = moving ? new Set(selection.bedKeys) : null;
    const excludedFixtures = moving ? new Set(selection.fixtureKeys) : null;
    const excludedLabels = moving ? new Set(selection.labelIds) : null;
    const visibleBlocks = excludedBlocks ? Object.fromEntries(Object.entries(floor.blocks).filter(([key]) => !excludedBlocks.has(key))) : floor.blocks;
    paintBlocks(context, visibleBlocks, x, y, size);
    for (const [key, rotation] of Object.entries(floor.doors)) {
      if (excludedDoors?.has(key)) continue;
      const [col, row] = readKey(key);
      drawDoor(context, x + col * size, y + row * size, size, rotation);
    }
    for (const [key, rotation] of Object.entries(floor.windows)) {
      if (excludedWindows?.has(key)) continue;
      const [col, row] = readKey(key);
      drawWindow(context, x + col * size, y + row * size, size, rotation);
    }
    for (const [key, rotation] of Object.entries(floor.stairs)) {
      if (excludedStairs?.has(key)) continue;
      const [col, row] = readKey(key);
      drawStair(context, x + col * size, y + row * size, size, rotation);
    }
    for (const [key, rotation] of Object.entries(floor.beds)) {
      if (excludedBeds?.has(key)) continue;
      const [col, row] = readKey(key);
      drawBed(context, x + col * size, y + row * size, size, rotation);
    }
    paintFixtures(context,floor.fixtures,x,y,size,1,excludedFixtures);
    if (options.preview && ['wall', 'rectangle'].includes(gesture?.mode)) {
      const cells = gesture.mode === 'wall' ? lineCells(gesture.start, gesture.current, true) : perimeterCells(gesture.start, gesture.current);
      paintBlocks(context, Object.fromEntries(cells.map(c => [cellKey(c.x, c.y), true])), x, y, size, 'rgba(32, 138, 97, .7)');
    }
    if (options.preview && gesture?.mode === 'window') {
      const cells = lineCells(gesture.start, gesture.current, true);
      const rotation = windowRunRotation(gesture.start, gesture.current);
      for (const cell of cells) drawWindow(context, x + cell.x * size, y + cell.y * size, size, rotation, .75);
    }
    if (options.preview && RECT_FIXTURES.includes(gesture?.mode)) {
      const b=makeBoundary(gesture.start,gesture.current);
      for(let row=b.y1;row<=b.y2;row++)for(let col=b.x1;col<=b.x2;col++)drawFixture(context,x+col*size,y+row*size,size,{type:gesture.mode},.55);
    }
    if (options.preview && gesture?.mode === 'counter') for(const c of lineCells(gesture.start,gesture.current,true))drawFixture(context,x+c.x*size,y+c.y*size,size,{type:'counter'},.6);
    if (options.preview && gesture?.mode === 'boundary') drawBoundary(context, makeBoundary(gesture.start, gesture.current), x, y, size, true);
    if (options.preview && hovered && !gesture && tool !== 'pan' && !spaceDown) {
      context.fillStyle = 'rgba(49, 133, 93, .12)';
      context.fillRect(x + hovered.x * size, y + hovered.y * size, size, size);
      context.lineWidth = 2;
      context.strokeStyle = '#4f9a76';
      context.strokeRect(x + hovered.x * size + 1, y + hovered.y * size + 1, size - 2, size - 2);
      if (EXTRA_TYPES.includes(tool) && !RECT_FIXTURES.includes(tool) && !LINE_FIXTURES.includes(tool)) {
        const fixture={type:tool,rotation:objectRotations[tool]||0};
        if(fixtureCells(hovered,fixture).every(inBounds))for(const c of fixtureCells(hovered,fixture))drawFixture(context,x+c.x*size,y+c.y*size,size,fixture,.47);
      }
      if (tool === 'bed' && bedCells(hovered, objectRotations.bed).every(inBounds)) drawBed(context, x + hovered.x * size, y + hovered.y * size, size, objectRotations.bed, .47);
      if (tool === 'window') drawWindow(context, x + hovered.x * size, y + hovered.y * size, size, objectRotations.window, .52);
      if (tool === 'stairs') drawStair(context, x + hovered.x * size, y + hovered.y * size, size, objectRotations.stairs, .48);
    }
    drawLabels(context, excludedLabels ? floor.labels.filter(label => !excludedLabels.has(label.id)) : floor.labels, x, y, size);
    // Ruler overlays are never part of the floor's saved/exported data.
    if (options.preview && (gesture?.mode === 'measure' || measurement)) {
      const active = gesture?.mode === 'measure'
        ? { type: gesture.measureType, start: gesture.start, end: gesture.current }
        : measurement;
      drawMeasurement(context, active, x, y, size);
    }
    if (options.preview && tool === 'select') {
      if (moving) {
        const { dx, dy } = gesture.delta;
        const b = translateBounds(selection.bounds, dx, dy);
        context.fillStyle = 'rgba(35, 142, 106, .095)';
        context.fillRect(x + b.x1 * size, y + b.y1 * size, (b.x2 - b.x1 + 1) * size, (b.y2 - b.y1 + 1) * size);
        const movedBlocks = Object.fromEntries(selection.blockKeys.filter(key => floor.blocks[key]).map(key => {
          const [col, row] = readKey(key);
          return [cellKey(col + dx, row + dy), true];
        }));
        paintBlocks(context, movedBlocks, x, y, size, '#338d68');
        for (const key of selection.doorKeys) {
          if (!Object.hasOwn(floor.doors, key)) continue;
          const [col, row] = readKey(key);
          drawDoor(context, x + (col + dx) * size, y + (row + dy) * size, size, floor.doors[key]);
        }
        for (const key of selection.windowKeys) {
          if (!Object.hasOwn(floor.windows, key)) continue;
          const [col, row] = readKey(key);
          drawWindow(context, x + (col + dx) * size, y + (row + dy) * size, size, floor.windows[key]);
        }
        for (const key of selection.stairKeys) {
          if (!Object.hasOwn(floor.stairs, key)) continue;
          const [col, row] = readKey(key);
          drawStair(context, x + (col + dx) * size, y + (row + dy) * size, size, floor.stairs[key]);
        }
        for (const key of selection.bedKeys) {
          if (!Object.hasOwn(floor.beds, key)) continue;
          const [col, row] = readKey(key);
          drawBed(context, x + (col + dx) * size, y + (row + dy) * size, size, floor.beds[key]);
        }
        paintFixtures(context,floor.fixtures,x,y,size,1,new Set(Object.keys(floor.fixtures).filter(k=>!selection.fixtureKeys.includes(k))),dx,dy);
        drawLabels(context, floor.labels.filter(label => excludedLabels.has(label.id)).map(label => ({ ...label, x: label.x + dx, y: label.y + dy })), x, y, size);
        drawSelectionOutline(context, b, x, y, size);
      } else if (gesture?.mode === 'select') {
        drawSelectionOutline(context, makeBoundary(gesture.start, gesture.current), x, y, size);
      } else if (selection) {
        drawSelectionOutline(context, selection.bounds, x, y, size);
      }
    }
    context.restore();
    context.strokeStyle = '#d8dddc'; context.lineWidth = 1;
    context.strokeRect(x + .5, y + .5, width, height);
  }
  function draw() {
    const dpr = canvas.width / canvasWidth;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);
    ctx.fillStyle = '#f4f6f6';
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);
    renderBoard(ctx, view.x, view.y, view.size, { shadow: true, preview: true, ghost: showBelow });
  }

  function safeFilename() {
    return (state.projectName.trim() || 'minecraft-build').replace(/[^a-z0-9_ -]/gi, '').trim().replace(/\s+/g, '-').slice(0, 45) || 'minecraft-build';
  }
  function downloadBlob(data, filename, type) {
    const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = filename;
    document.body.append(anchor);
    anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
  function exportPng() {
    const tile = 28;
    const pad = 38;
    const top = 106;
    const width = state.cols * tile + pad * 2;
    const height = state.rows * tile + top + pad;
    const output = document.createElement('canvas');
    output.width = width * 2;
    output.height = height * 2;
    const context = output.getContext('2d');
    context.scale(2, 2);
    context.fillStyle = '#f6f7f7'; context.fillRect(0, 0, width, height);
    context.fillStyle = '#23342c';
    context.font = '800 24px ui-sans-serif, system-ui, sans-serif';
    context.fillText(state.projectName || 'My Minecraft Build', pad, 46, width - pad * 2);
    context.fillStyle = '#6b8176';
    context.font = '600 13px ui-sans-serif, system-ui, sans-serif';
    context.fillText(`${activeFloor().name}   •   ${state.cols} × ${state.rows} blocks`, pad, 74);
    renderBoard(context, pad, top, tile, { preview: false, ghost: false, shadow: false });
    output.toBlob(blob => {
      if (blob) { downloadBlob(blob, `${safeFilename()}-${activeFloor().name.replace(/[^a-z0-9_-]/gi, '-')}.png`, 'image/png'); showToast('PNG floorplan exported'); }
      else showToast('Could not export the image');
    }, 'image/png');
  }

  function resizeGrid() {
    clearSelection();
    openModal({
      title: 'Grid dimensions',
      description: 'Each square is one Minecraft block. Resizing changes every floor and crops blocks outside the new area.',
      button: 'Apply size',
      fields: [
        { name: 'width', label: 'Width (blocks)', type: 'number', min: 8, max: 120, value: state.cols },
        { name: 'height', label: 'Depth (blocks)', type: 'number', min: 8, max: 120, value: state.rows }
      ],
      onSubmit: values => {
        const cols = Number(values.width), rows = Number(values.height);
        if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 8 || cols > 120 || rows < 8 || rows > 120) throw Error('Use whole numbers between 8 and 120.');
        if (cols < state.cols || rows < state.rows) {
          if (!confirm('Blocks, doors and labels outside the new grid will be cropped. Continue?')) return false;
        }
        change(() => {
          state.cols = cols; state.rows = rows;
          for (const floor of state.floors) {
            for (const key of Object.keys(floor.beds)) {
              const [x, y] = readKey(key);
              if (bedCells({ x, y }, floor.beds[key]).some(cell => cell.x >= cols || cell.y >= rows)) delete floor.beds[key];
            }
            for (const [key,fixture] of Object.entries(floor.fixtures || {})) {
              const [x,y]=readKey(key);
              if(fixtureCells({x,y},fixture).some(c=>c.x<0||c.y<0||c.x>=cols||c.y>=rows))delete floor.fixtures[key];
            }
            for (const key of Object.keys(floor.stairs)) { const [x, y] = readKey(key); if (x >= cols || y >= rows) delete floor.stairs[key]; }
            for (const key of Object.keys(floor.windows)) { const [x, y] = readKey(key); if (x >= cols || y >= rows) delete floor.windows[key]; }
            for (const key of Object.keys(floor.blocks)) { const [x, y] = readKey(key); if (x >= cols || y >= rows) delete floor.blocks[key]; }
            for (const key of Object.keys(floor.doors)) { const [x, y] = readKey(key); if (x >= cols || y >= rows) delete floor.doors[key]; }
            floor.labels = floor.labels.filter(label => label.x < cols && label.y < rows);
            if (floor.boundary) {
              if (floor.boundary.x1 >= cols || floor.boundary.y1 >= rows) floor.boundary = null;
              else { floor.boundary.x2 = Math.min(floor.boundary.x2, cols - 1); floor.boundary.y2 = Math.min(floor.boundary.y2, rows - 1); }
            }
          }
        });
        resetMeasurement();
        fitView();
      }
    });
  }

  // The reference guide is separate from the editor's input modal.
  function openHelp() { $('helpDialog').showModal(); }
  function closeHelp() { $('helpDialog').close(); }
  $('openHelp').addEventListener('click', openHelp);
  $('sidebarHelp').addEventListener('click', openHelp);
  $('closeHelp').addEventListener('click', closeHelp);
  $('doneHelp').addEventListener('click', closeHelp);
  $('helpDialog').addEventListener('click', event => {
    if (event.target === $('helpDialog')) closeHelp();
  });

  // Controls and keyboard access.
  toolButtons.forEach(button => button.addEventListener('click', () => setTool(button.dataset.tool)));
  $('rotateObject').addEventListener('click', rotateActiveObject);
  $('clearBoundary').addEventListener('click', () => change(() => { activeFloor().boundary = null; }));
  $('clearSelection').addEventListener('click', clearSelection);
  $('clearMeasure').addEventListener('click', resetMeasurement);
  for (const button of document.querySelectorAll('[data-measure-mode]')) {
    button.addEventListener('click', () => { measureMode = button.dataset.measureMode; resetMeasurement(); });
  }
  $('addFloor').addEventListener('click', () => addFloor(false));
  $('duplicateFloor').addEventListener('click', () => addFloor(true));
  $('showBelow').addEventListener('change', event => { showBelow = event.target.checked; requestDraw(); });
  $('resizeGrid').addEventListener('click', resizeGrid);
  $('newBuild').addEventListener('click', () => addBuild());
  $('renameBuild').addEventListener('click', renameBuild);
  $('duplicateBuild').addEventListener('click', () => addBuild(true));
  $('undo').addEventListener('click', undo);
  $('redo').addEventListener('click', redo);
  $('zoomIn').addEventListener('click', () => setZoom(1.2));
  $('zoomOut').addEventListener('click', () => setZoom(1 / 1.2));
  $('fitView').addEventListener('click', fitView);
  $('exportPng').addEventListener('click', exportPng);
  $('exportJson').addEventListener('click', () => { downloadBlob(JSON.stringify(state, null, 2), `${safeFilename()}.json`, 'application/json'); showToast('Current build backed up as JSON'); });
  $('exportWorkspace').addEventListener('click', () => { save(); downloadBlob(JSON.stringify({ type: 'blockplan-workspace', version: 1, ...workspace }, null, 2), 'BlockPlan-all-builds.json', 'application/json'); showToast('All build tabs backed up as JSON'); });
  $('importPlan').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', async event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      if (file.size > 8_000_000) throw Error('This project file is too large.');
      const input = JSON.parse(await file.text());
      if (input?.type === 'blockplan-workspace') {
        const incoming = normalizeWorkspace(input);
        if (workspace.projects.length + incoming.projects.length > MAX_PROJECTS) throw Error(`There is only room for ${MAX_PROJECTS - workspace.projects.length} more build tabs.`);
        // Import as additional tabs, so existing work is never overwritten.
        for (const entry of incoming.projects) workspace.projects.push({ id: makeId(), plan: entry.plan });
        switchBuild(workspace.projects[workspace.projects.length - incoming.projects.length].id);
        save(); updateUI();
        showToast(`Imported ${incoming.projects.length} builds as new tabs`);
      } else {
        const imported = normalizePlan(input);
        addBuild(false, imported);
      }
    } catch (error) { showToast(error.message || 'Could not read this JSON file'); }
  });
  function dismissHint() { hintDismissed = true; $('canvasHint').classList.add('hidden'); }
  $('hintClose').addEventListener('click', dismissHint);
  $('hintClose').addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); dismissHint(); } });

  const shortcuts = { m: 'measure', w: 'wall', q: 'rectangle', b: 'block', s: 'select', d: 'door', x: 'window', f: 'bed', g: 'stairs', t: 'label', o: 'boundary', e: 'erase', v: 'pan' };
  document.addEventListener('keydown', event => {
    const textInput = event.target.matches('input, textarea, select') || $('editorDialog').open || $('helpDialog').open;
    if (textInput) return;
    if (event.key === 'Escape' && gesture) {
      if (gesture.before) state = JSON.parse(gesture.before);
      gesture = null; $('wallMeasure').hidden = true; updateMeasureControls(); updateUI(); updateCursor(); requestDraw(); return;
    }
    if (event.key === 'Escape' && tool === 'measure' && measurement) { event.preventDefault(); resetMeasurement(); return; }
    if (event.key === 'Escape' && selection) { event.preventDefault(); clearSelection(); return; }
    if ((event.key === 'Delete' || event.key === 'Backspace') && selection && tool === 'select') { event.preventDefault(); deleteSelection(); return; }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault(); if (event.shiftKey) redo(); else undo(); return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); return; }
    if (event.key === ' ' && !event.repeat) { event.preventDefault(); spaceDown = true; updateCursor(); return; }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === '?') { event.preventDefault(); openHelp(); return; }
    const key = event.key.toLowerCase();
    if (shortcuts[key]) { event.preventDefault(); setTool(shortcuts[key]); }
    if (key === 'r') { event.preventDefault(); if (Object.hasOwn(objectRotations, tool)) rotateActiveObject(); else { setTool('door'); rotateActiveObject(); } }
    if (key === '+' || key === '=') { event.preventDefault(); setZoom(1.2); }
    if (key === '-') { event.preventDefault(); setZoom(1 / 1.2); }
  });
  document.addEventListener('keyup', event => { if (event.key === ' ') { spaceDown = false; updateCursor(); } });
  window.addEventListener('blur', () => { spaceDown = false; updateCursor(); });

  updateSelectionUI();
  updateUI();
  setTool('wall');
  resizeCanvas();
  save();
})();
