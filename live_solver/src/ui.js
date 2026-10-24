// DOM 交互层：状态条、工具栏、编辑盘面、设置。

const SETTINGS_KEY = 'sudoku.live.settings.v1';
const FPS_CHOICES = [6, 10, 12, 15, 20, 30];

export const DEFAULT_SETTINGS = {
  fps: 30,
  sensitivity: 'medium',
  highlight: true,
  wakelock: false,
  debug: false,
};

export class UI {
  constructor() {
    const $ = (id) => document.getElementById(id);
    this.el = {
      stage: $('stage'),
      status: $('status'),
      gate: $('gate'),
      loading: $('loading'),
      errorCard: $('error-card'),
      errorText: $('error-text'),
      bottombar: $('bottombar'),
      btnStart: $('btn-start'),
      btnPhotoGate: $('btn-photo-gate'),
      btnRetry: $('btn-retry'),
      btnSettings: $('btn-settings'),
      btnFreeze: $('btn-freeze'),
      btnTorch: $('btn-torch'),
      editPanel: $('edit-panel'),
      editGrid: $('edit-grid'),
      editHint: $('edit-hint'),
      editIgnore: $('edit-ignore'),
      numpad: $('numpad'),
      settingsPanel: $('settings-panel'),
      setFps: $('set-fps'),
      setSens: $('set-sens'),
      setHighlight: $('set-highlight'),
      setWakelock: $('set-wakelock'),
      setDebug: $('set-debug'),
      btnSaveWarp: $('btn-save-warp'),
      toast: $('toast'),
      debug: $('debug'),
      fileInput: $('file-input'),
    };

    this.handlers = {};
    this.selectedCell = -1;
    this.settings = loadSettings();
    this.toastTimer = 0;

    this.buildEditGrid();
    this.buildNumpad();
    this.applySettingsToControls();

    // 编辑/设置是盖在画面上的大面板：手机上几乎占满屏幕，桌面上居中。
    // 按住标题栏可以拖到一边，方便对照原题。
    makeDraggable(this.el.editPanel, this.el.stage);
    makeDraggable(this.el.settingsPanel, this.el.stage);
  }

  bind(handlers) {
    this.handlers = handlers;
    const on = (el, type, fn) => el && el.addEventListener(type, fn);

    on(this.el.btnStart, 'click', () => handlers.onStart?.());
    on(this.el.btnPhotoGate, 'click', () => handlers.onPickPhoto?.());
    on(this.el.btnRetry, 'click', () => handlers.onRetry?.());
    on(this.el.btnSettings, 'click', () => this.openSettings());
    on(this.el.fileInput, 'change', (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (file) handlers.onPhoto?.(file);
    });

    this.el.bottombar
      .querySelectorAll('[data-action]')
      .forEach((btn) => {
        btn.addEventListener('click', () => {
          const action = btn.dataset.action;
          if (action === 'freeze') handlers.onFreeze?.();
          else if (action === 'switch') handlers.onSwitch?.();
          else if (action === 'torch') handlers.onTorch?.();
          else if (action === 'photo') handlers.onPickPhoto?.();
          else if (action === 'edit') handlers.onEdit?.();
        });
      });

    this.el.editPanel
      .querySelectorAll('[data-action]')
      .forEach((btn) => {
        btn.addEventListener('click', () => {
          const action = btn.dataset.action;
          if (action === 'close-edit') handlers.onCloseEdit?.();
          else if (action === 'done') handlers.onDoneEdit?.();
          else if (action === 'reread') handlers.onReread?.();
          else if (action === 'ignore') handlers.onIgnoreUnknown?.();
        });
      });

    this.el.settingsPanel
      .querySelectorAll('[data-action="close-settings"]')
      .forEach((btn) => btn.addEventListener('click', () => this.closeSettings()));

    on(this.el.btnSaveWarp, 'click', () => handlers.onSaveWarp?.());

    on(this.el.setFps, 'change', () => this.saveSettings());
    on(this.el.setSens, 'change', () => this.saveSettings());
    on(this.el.setHighlight, 'change', () => this.saveSettings());
    on(this.el.setWakelock, 'change', () => this.saveSettings());
    on(this.el.setDebug, 'change', () => this.saveSettings());

    document.addEventListener('keydown', (e) => {
      if (this.el.editPanel.hidden || this.selectedCell < 0) return;
      if (e.key >= '1' && e.key <= '9') {
        handlers.onCellEdit?.(this.selectedCell, Number(e.key));
      } else if (e.key === 'Backspace' || e.key === 'Delete' || e.key === '0') {
        handlers.onCellEdit?.(this.selectedCell, 0);
      } else if (e.key === 'Escape') {
        this.deselectCell();
      }
    });
  }

  saveSettings() {
    this.settings = {
      fps: Number(this.el.setFps.value),
      sensitivity: this.el.setSens.value,
      highlight: this.el.setHighlight.checked,
      wakelock: this.el.setWakelock.checked,
      debug: this.el.setDebug.checked,
    };
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
      // 忽略隐私模式下的写入失败
    }
    this.handlers.onSettings?.(this.settings);
  }

  applySettingsToControls() {
    const s = this.settings;
    this.el.setFps.value = String(s.fps);
    this.el.setSens.value = s.sensitivity;
    this.el.setHighlight.checked = s.highlight;
    this.el.setWakelock.checked = s.wakelock;
    this.el.setDebug.checked = s.debug;
  }

  getSettings() {
    return { ...this.settings };
  }

  setState(text, kind = 'info') {
    this.el.status.textContent = text;
    this.el.status.dataset.kind = kind;
  }

  showGate() {
    this.el.gate.hidden = false;
  }

  hideGate() {
    this.el.gate.hidden = true;
  }

  showLoading() {
    this.el.loading.hidden = false;
  }

  hideLoading() {
    this.el.loading.hidden = true;
  }

  showError(message) {
    this.el.errorText.textContent = message;
    this.el.errorCard.hidden = false;
  }

  hideError() {
    this.el.errorCard.hidden = true;
  }

  showBars() {
    this.el.bottombar.hidden = false;
  }

  hideBars() {
    this.el.bottombar.hidden = true;
  }

  setFrozen(frozen) {
    this.el.btnFreeze.textContent = frozen ? '继续' : '定格';
  }

  setTorchVisible(visible) {
    this.el.btnTorch.hidden = !visible;
  }

  openEditPanel() {
    // 每次打开回到默认位置，避免上次拖动后的坐标在转屏/换设备后跑出屏幕。
    resetSheetPosition(this.el.editPanel);
    this.el.editPanel.hidden = false;
  }

  closeEditPanel() {
    this.el.editPanel.hidden = true;
    this.deselectCell();
  }

  isEditOpen() {
    return !this.el.editPanel.hidden;
  }

  buildEditGrid() {
    this.cells = [];
    for (let i = 0; i < 81; i++) {
      const div = document.createElement('div');
      div.className = 'cell';
      div.dataset.index = String(i);
      div.innerHTML = '<span class="val"></span>';
      div.addEventListener('click', () => this.selectCell(i));
      this.el.editGrid.appendChild(div);
      this.cells.push(div);
    }
  }

  buildNumpad() {
    this.el.numpad.innerHTML = '';
    for (let d = 1; d <= 9; d++) {
      const b = document.createElement('button');
      b.textContent = String(d);
      b.addEventListener('click', () => {
        if (this.selectedCell >= 0) {
          this.handlers.onCellEdit?.(this.selectedCell, d);
        }
      });
      this.el.numpad.appendChild(b);
    }
    const clear = document.createElement('button');
    clear.textContent = '清除';
    clear.addEventListener('click', () => {
      if (this.selectedCell >= 0) {
        this.handlers.onCellEdit?.(this.selectedCell, 0);
      }
    });
    const cancel = document.createElement('button');
    cancel.textContent = '取消';
    cancel.addEventListener('click', () => this.deselectCell());
    this.el.numpad.appendChild(clear);
    this.el.numpad.appendChild(cancel);
  }

  selectCell(index) {
    this.selectedCell = index;
    this.el.numpad.hidden = false;
    this.highlightSelection();
  }

  deselectCell() {
    this.selectedCell = -1;
    this.el.numpad.hidden = true;
    this.highlightSelection();
  }

  highlightSelection() {
    for (let i = 0; i < 81; i++) {
      this.cells[i].classList.toggle('selected', i === this.selectedCell);
    }
  }

  /**
   * @param {{grid:Uint8Array, details:Array, conflicts:Set<number>|number[], unknown:Uint8Array}} data
   */
  renderEditor({ grid, details, conflicts, unknown }) {
    const conflictSet = new Set(conflicts || []);
    for (let i = 0; i < 81; i++) {
      const cell = this.cells[i];
      const value = grid ? grid[i] : 0;
      const detail = details?.[i];
      const hint =
        !value && detail && detail.kind !== 'digit' ? detail.guess || 0 : 0;

      cell.innerHTML = '';
      const val = document.createElement('span');
      val.className = 'val';
      val.textContent = value ? String(value) : '';
      cell.appendChild(val);

      if (hint) {
        const h = document.createElement('span');
        h.className = 'hint';
        h.textContent = String(hint);
        cell.appendChild(h);
      }

      cell.classList.toggle('conflict', conflictSet.has(i));
      cell.classList.toggle(
        'uncertain',
        !!unknown && !!unknown[i] && !conflictSet.has(i),
      );
    }
    this.highlightSelection();

    // 有待确认格时才提供“都当空格”，否则按钮只是占地方。
    if (this.el.editIgnore) {
      this.el.editIgnore.hidden = !unknown || !unknown.some((v) => v);
    }
  }

  setEditHint(text) {
    this.el.editHint.textContent = text;
  }

  openSettings() {
    resetSheetPosition(this.el.settingsPanel);
    this.el.settingsPanel.hidden = false;
  }

  closeSettings() {
    this.el.settingsPanel.hidden = true;
  }

  toast(message, ms = 2200) {
    this.el.toast.textContent = message;
    this.el.toast.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.el.toast.hidden = true;
    }, ms);
  }

  setDebug(text) {
    if (text) {
      this.el.debug.textContent = text;
      this.el.debug.hidden = false;
    } else {
      this.el.debug.hidden = true;
    }
  }
}

// 拖到边缘后至少留这么多像素在屏幕内，随时能抓回来。
// 纵向留 72px：16px 顶部内边距 + 40px 标题栏，避开手机底部的手势条。
const EDGE_KEEP_X = 72;
const EDGE_KEEP_Y = 72;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/** 清除拖动留下的像素定位，恢复到 CSS 里的默认位置（手机底部、桌面居中）。 */
function resetSheetPosition(sheet) {
  if (!sheet) return;
  for (const prop of ['left', 'top', 'right', 'bottom', 'width', 'transform']) {
    sheet.style.removeProperty(prop);
  }
  sheet.classList.remove('dragging');
}

/**
 * 按住标题栏拖动面板。编辑/设置面板又大又居中，会挡住摄像头画面；
 * 拖开后既能看题面又能改格子。用 pointer 事件同时覆盖鼠标与触摸。
 */
function makeDraggable(sheet, stage) {
  const head = sheet?.querySelector('.sheet-head');
  if (!head || !stage) return;
  let drag = null;

  head.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest('button')) return; // 关闭按钮照常点击

    const stageRect = stage.getBoundingClientRect();
    const rect = sheet.getBoundingClientRect();
    // 转成相对 #stage 的显式像素坐标，之后就不受 translateX(-50%) 影响。
    sheet.style.left = `${rect.left - stageRect.left}px`;
    sheet.style.top = `${rect.top - stageRect.top}px`;
    sheet.style.right = 'auto';
    sheet.style.bottom = 'auto';
    sheet.style.width = `${rect.width}px`;
    sheet.style.transform = 'none';
    sheet.classList.add('dragging');

    drag = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      left: rect.left - stageRect.left,
      top: rect.top - stageRect.top,
      width: rect.width,
      stageW: stageRect.width,
      stageH: stageRect.height,
    };
    head.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  });

  head.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const left = clamp(
      drag.left + (e.clientX - drag.startX),
      EDGE_KEEP_X - drag.width,
      drag.stageW - EDGE_KEEP_X,
    );
    // 允许拖到屏幕下方，只露标题栏，给画面让位。
    const top = clamp(
      drag.top + (e.clientY - drag.startY),
      0,
      Math.max(0, drag.stageH - EDGE_KEEP_Y),
    );
    sheet.style.left = `${left}px`;
    sheet.style.top = `${top}px`;
  });

  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag = null;
    sheet.classList.remove('dragging');
    if (head.hasPointerCapture?.(e.pointerId)) {
      head.releasePointerCapture(e.pointerId);
    }
  };
  head.addEventListener('pointerup', endDrag);
  head.addEventListener('pointercancel', endDrag);
  head.addEventListener('lostpointercapture', endDrag);

  // 转屏/改窗口大小后把拖动过的面板重新拉回可视范围，否则可能整个跑到屏外。
  window.addEventListener('resize', () => {
    if (sheet.hidden || drag || !sheet.style.left) return;
    const stageRect = stage.getBoundingClientRect();
    const left = parseFloat(sheet.style.left) || 0;
    const top = parseFloat(sheet.style.top) || 0;
    const width = parseFloat(sheet.style.width) || sheet.getBoundingClientRect().width;
    sheet.style.left = `${clamp(left, EDGE_KEEP_X - width, stageRect.width - EDGE_KEEP_X)}px`;
    sheet.style.top = `${clamp(top, 0, Math.max(0, stageRect.height - EDGE_KEEP_Y))}px`;
  });
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const saved = JSON.parse(raw);
    // 12 是老版本的默认值：当时没动过设置的用户升级到 30fps。
    // 主动选过 6/10/15/20 的保持原样；无法识别的值退回默认。
    if (saved.fps === 12) saved.fps = DEFAULT_SETTINGS.fps;
    if (!FPS_CHOICES.includes(saved.fps)) saved.fps = DEFAULT_SETTINGS.fps;
    return { ...DEFAULT_SETTINGS, ...saved };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
