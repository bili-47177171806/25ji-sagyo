// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2025-2026 The 25-ji-code-de Team

/**
 * Todo List Component
 * Enhanced Pomodoro-centric Todo List
 * 改进版待办事项：支持今日计划 vs 活动清单，番茄预估与追踪，干扰记录
 */
class TodoList {
  constructor() {
    // DOM Elements
    this.panel = document.getElementById('todoPanel');
    this.closeBtn = document.getElementById('todoCloseBtn');
    this.toggleBtn = document.getElementById('todoListBtn');
    
    // Inputs (Updated for separate Today/Inbox Inputs)
    this.inputToday = document.getElementById('newTodoInputToday');
    this.addBtnToday = document.getElementById('addTodoBtnToday');
    
    this.inputInbox = document.getElementById('newTodoInputInbox');
    this.addBtnInbox = document.getElementById('addTodoBtnInbox');
    
    this.todayCount = document.getElementById('todayCount');
    
    // Fallbacks if one is missing (backwards compat)
    this.input = this.inputInbox || document.getElementById('newTodoInput');
    this.addBtn = this.addBtnInbox || document.getElementById('addTodoBtn');

    // Containers
    this.listToday = document.getElementById('todoListToday');
    this.listInventory = document.getElementById('todoListInventory');
    
    // Stats
    this.clearCompletedBtn = document.getElementById('clearCompletedBtn');
    this.statsSpan = document.querySelector('.todo-stats');
    this.totalEstSpan = document.getElementById('totalEst');
    
    // Storage key
    this.STORAGE_KEY = 'sagyo_todo_list_v2';
    
    // Data
    this.todos = [];
    this.activeTaskId = null;
    
    // Check elements
    if (!this.panel || !this.toggleBtn) {
      console.warn('Todo List elements not found');
      return;
    }

    this.init();
  }

  init() {
    this.loadTodos();
    this.render();
    this.addEventListeners();
    this.exposeGlobalAPI();
  }

  // --- Data Management ---

  loadTodos() {
    try {
      const raw = localStorage.getItem(this.STORAGE_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        this.todos = (data.todos || []).map(t => this.migrateTaskStructure(t));
        this.activeTaskId = data.activeTaskId || null;
      } else {
        // Fallback to old key if v2 not found
        const oldRaw = localStorage.getItem('sagyo_todo_list');
        if (oldRaw) {
          const oldData = JSON.parse(oldRaw);
          this.todos = (oldData.todos || []).map(t => this.migrateTaskStructure(t));
          this.activeTaskId = oldData.activeTaskId || null;
        }
      }
    } catch (e) {
      console.warn('Failed to load todos:', e);
      this.todos = [];
    }
  }

  saveTodos() {
    try {
      const data = {
        todos: this.todos,
        activeTaskId: this.activeTaskId
      };
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      console.warn('Failed to save todos:', e);
    }
  }

  migrateTaskStructure(todo) {
    // Ensure task has all v2 fields
    return {
      id: todo.id,
      text: todo.text,
      completed: todo.completed || false,
      createdAt: todo.createdAt || Date.now(),
      
      // V2 Fields
      type: todo.type || 'inventory', // 'today' or 'inventory'
      isUnplanned: todo.isUnplanned || false, // 'U'
      
      estPomo: todo.estPomo !== undefined ? todo.estPomo : 0, // □
      actPomo: todo.actPomo !== undefined ? todo.actPomo : (todo.pomodoroCount || 0), // ☒
      overPomo: todo.overPomo || 0, // ○ (extra estimation)
      
      interruptions: todo.interruptions || { internal: 0, external: 0 }
    };
  }

  generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
  }

  // --- Core Logic ---

  addTodo(text, type = 'inventory', isUnplanned = false) {
    const trimmed = text.trim();
    if (!trimmed) return null;
    
    const todo = {
      id: this.generateId(),
      text: trimmed,
      completed: false,
      createdAt: Date.now(),
      type: type,
      isUnplanned: isUnplanned,
      estPomo: 0, 
      actPomo: 0,
      overPomo: 0,
      interruptions: { internal: 0, external: 0 }
    };
    
    // Add to top of respective list logic (represented by array order)
    this.todos.unshift(todo);
    
    this.saveTodos();
    this.render();
    return todo;
  }

  deleteTodo(id) {
    this.todos = this.todos.filter(t => t.id !== id);
    if (this.activeTaskId === id) this.activeTaskId = null;
    this.saveTodos();
    this.render();
  }

  toggleTodo(id) {
    const todo = this.todos.find(t => t.id === id);
    if (todo) {
      todo.completed = !todo.completed;
      this.saveTodos();
      this.render();
    }
  }

  moveTask(id, targetType) {
    const todo = this.todos.find(t => t.id === id);
    if (todo) {
      todo.type = targetType;
      // If moving to today, maybe default estPomo to 1 if 0?
      if (targetType === 'today' && todo.estPomo === 0) {
        todo.estPomo = 1; 
      }
      this.saveTodos();
      this.render();
    }
  }

  setActiveTask(id) {
    // Only allow active tasks from 'today' ideally, but allow logic to support any
    this.activeTaskId = id;
    
    // If setting an active task that's in inventory, auto-move to today
    if (id) {
      const todo = this.todos.find(t => t.id === id);
      if (todo && todo.type !== 'today') {
        todo.type = 'today';
        if (todo.estPomo === 0) todo.estPomo = 1; // Default 1 pomo estimation
      }
    }
    
    this.saveTodos();
    this.render();
    
    const event = new CustomEvent('todoActiveTaskChanged', { 
      detail: { taskId: id, task: this.todos.find(t => t.id === id) }
    });
    document.dispatchEvent(event);
  }

  // --- Pomodoro Logic ---

  adjustEstimation(id, delta) {
    const todo = this.todos.find(t => t.id === id);
    if (!todo) return;
    
    if (delta > 0) {
       // Adding
       if (todo.actPomo >= todo.estPomo) {
         todo.overPomo++;
       } else {
         todo.estPomo++;
       }
    } else {
      // Removing logic if needed, currently only UI for adding
      // But keeping logic extensible
      if (todo.overPomo > 0) {
        todo.overPomo--;
      } else if (todo.estPomo > todo.actPomo) { 
        todo.estPomo--;
      }
    }
    
    this.saveTodos();
    this.render();
    this.dispatchDataChanged();
  }

  addInterruption(id, type) {
    const todo = this.todos.find(t => t.id === id);
    if (todo) {
      if (type === 'internal') todo.interruptions.internal++;
      if (type === 'external') todo.interruptions.external++;
      this.saveTodos();
      this.render();
      this.dispatchDataChanged();
    }
  }

  incrementPomodoroCount(id) {
    const todo = this.todos.find(t => t.id === id);
    if (todo) {
      todo.actPomo++;
      this.saveTodos();
      this.render();
      this.dispatchDataChanged();
    }
  }

  /**
   * 通知其他组件数据已变化
   */
  dispatchDataChanged() {
    document.dispatchEvent(new CustomEvent('todoDataChanged'));
  }

  clearCompleted() {
    this.todos = this.todos.filter(t => !t.completed);
    this.saveTodos();
    this.render();
  }

  // --- Rendering ---

  render() {
    // Ensure containers exist (might not be ready depending on loading order, but init checks them)
    if (!this.listToday || !this.listInventory) return;
    
    const todayTasks = this.todos.filter(t => t.type === 'today' || t.id === this.activeTaskId);
    const inventoryTasks = this.todos.filter(t => t.type !== 'today' && t.id !== this.activeTaskId);

    // Stats
    const totalEst = todayTasks.reduce((acc, t) => acc + t.estPomo + t.overPomo, 0);
    if (this.totalEstSpan) this.totalEstSpan.textContent = totalEst;
    
    const activeCount = this.todos.filter(t => !t.completed).length;
    if (this.statsSpan) this.statsSpan.textContent = `${activeCount} items left`;

    // Render Lists
    this.renderList(this.listToday, todayTasks, 'today');
    this.renderList(this.listInventory, inventoryTasks, 'inventory');
  }

  renderList(container, tasks, listType) {
    if (tasks.length === 0) {
      container.innerHTML = listType === 'today'
        ? `<li class="todo-item-placeholder" style="text-align:center; opacity:0.5; padding:20px; font-size:13px;">
             <span class="sekai-icon-lg" style="display:block; margin: 0 auto 8px; opacity:0.7">${window.SVG_ICONS.moon}</span>
             <span data-i18n="todo.empty_today">No focus tasks yet</span>
           </li>`
        : `<li class="todo-item-placeholder" style="text-align:center; opacity:0.5; padding:20px; font-size:13px;">
             <span class="sekai-icon-lg" style="display:block; margin: 0 auto 8px; opacity:0.7">${window.SVG_ICONS.sparkles}</span>
             <span data-i18n="todo.empty_inbox">Inbox empty</span>
           </li>`;
      return;
    }

    container.innerHTML = tasks.map(t => this.renderTaskHTML(t, listType)).join('');
    
    // Bind Item Events
    tasks.forEach(task => this.bindTaskEvents(task, container));
  }

  renderTaskHTML(todo, listType) {
    const isActive = todo.id === this.activeTaskId;
    const completedClass = todo.completed ? 'completed' : '';
    const activeClass = isActive ? 'active-task' : '';
    
    // 1. Custom Visual Checkbox
    const checkboxHtml = `
      <div class="checkbox-v2 ${todo.completed ? 'checked' : ''}" role="checkbox" aria-checked="${todo.completed}"></div>
    `;
    
    // 2. Content
    // Unplanned badge now stylized as a small red dot/tag if needed, or kept simple
    const unplannedBadge = todo.isUnplanned 
       ? `<span style="color:#ff6b6b; font-weight:bold; margin-right:4px;" title="Unplanned" class="sekai-icon">${window.SVG_ICONS.zap}</span>` 
       : '';
       
    const contentHtml = `
       <span class="todo-text-v2 ${completedClass}">${unplannedBadge}${this.escapeHtml(todo.text)}</span>
    `;
    
    // 3. Pomodoro Visual Tokens (Tomatoes)
    // Replaced squares with Tomato icons
    let tokensHtml = '';
    
    // Estimation (Outlined Tomatoes)
    // Show max(estPomo, 1) tokens minimum? Or adhere to logic.
    // Logic: 
    // - Show Est tokens. If Done < Est, first Done tokens are filled. Remaining Est are outlined.
    // - If Done >= Est, show Done tokens filled. (Overhead is implicit in extra filled tokens)
    
    const countToShow = Math.max(todo.estPomo, todo.actPomo, 1);
    
    for (let i = 0; i < countToShow; i++) {
        let classes = 'pomo-token';
        // Logic: Is this token filled?
        if (i < todo.actPomo) {
            classes += ' done'; // Filled Red Tomato
        } else if (i < todo.estPomo) {
            classes += ' est';  // Outlined Grey Tomato
        } else {
            // This case (i >= est && i >= act) shouldn't happen with countToShow logic
            // Unless we want to show a "ghost" next step? No.
        }
        
        tokensHtml += `<div class="${classes}" title="Pomodoro ${i+1}"></div>`;
    }

    // Add Button (Visual +)
    const addBtnHtml = `<button class="pomo-add-btn-v2" title="Plan another Pomodoro">${window.SVG_ICONS.plus}</button>`;
    
    // 4. Visual Interruption Badges (Icons instead of text)
    const intInternalHtml = todo.interruptions.internal > 0 
      ? `<span class="int-badge internal" title="Internal Interruptions"><span class="int-icon-svg">${window.SVG_ICONS.cloud}</span> ${todo.interruptions.internal}</span>` 
      : `<span class="int-badge internal" style="opacity:0.3" title="Record Internal"><span class="int-icon-svg">${window.SVG_ICONS.cloud}</span></span>`;
      
    const intExternalHtml = todo.interruptions.external > 0
      ? `<span class="int-badge external" title="External Interruptions"><span class="int-icon-svg">${window.SVG_ICONS.phone}</span> ${todo.interruptions.external}</span>`
      : `<span class="int-badge external" style="opacity:0.3" title="Record External"><span class="int-icon-svg">${window.SVG_ICONS.phone}</span></span>`;
    
    // 5. Action Buttons (Hidden until Hover)
    // Move logic: Today <-> Inbox
    const moveIcon = listType === 'today' ? window.SVG_ICONS.package : window.SVG_ICONS.calendar;
    const moveTarget = listType === 'today' ? 'inventory' : 'today';
    const moveTitle = listType === 'today' ? 'Move to Inbox' : 'Move to Today';
    
    const actionsHtml = `
      <div class="todo-hover-actions">
         <button class="hover-btn focus" title="Focus This Task">${window.SVG_ICONS.target}</button>
         <button class="hover-btn move" data-target="${moveTarget}" title="${moveTitle}">${moveIcon}</button>
         <button class="hover-btn delete" title="Delete">${window.SVG_ICONS.x}</button>
      </div>
    `;

    // --- Template V2 Structure ---
    return `
      <li class="todo-item-v2 ${activeClass}" data-id="${todo.id}">
        <div class="todo-header-row">
           ${checkboxHtml}
           ${contentHtml}
           ${actionsHtml}
        </div>
        
        <div class="todo-footer-row">
           <div class="pomo-token-container">
              ${tokensHtml}
              ${addBtnHtml}
           </div>
           
           <div class="int-badges">
              ${intInternalHtml}
              ${intExternalHtml}
           </div>
        </div>
      </li>
    `;
  }

  bindTaskEvents(todo, container) {
    const item = container.querySelector(`.todo-item-v2[data-id="${todo.id}"]`);
    if (!item) return;
    
    // Checkbox
    item.querySelector('.checkbox-v2')?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleTodo(todo.id);
    });
    
    // Delete
    item.querySelector('.delete')?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.deleteTodo(todo.id);
    });
    
    // Move
    item.querySelector('.move')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const target = e.currentTarget.dataset.target;
        this.moveTask(todo.id, target);
    });

    // Focus
    item.querySelector('.focus')?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.setActiveTask(todo.id);
    });
    
    // Pomo Add (Estimation)
    item.querySelector('.pomo-add-btn-v2')?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.adjustEstimation(todo.id, 1);
    });
    
    // Interruption Internal
    item.querySelector('.int-badge.internal')?.addEventListener('click', (e) => {
       e.stopPropagation();
       this.addInterruption(todo.id, 'internal');
    });
    
    // Interruption External
    item.querySelector('.int-badge.external')?.addEventListener('click', (e) => {
       e.stopPropagation();
       this.addInterruption(todo.id, 'external');
    });
  }

  // --- Utils ---
  escapeHtml(text) {
    /*
     * 与 `js/utils/format.js` 同样的理由：`div.textContent → innerHTML`
     * 不转义引号，进属性上下文会被闭合。当前只用在元素内容里（第 319 行），
     * 今天安全 —— 但下一个属性用法不会有任何提示。
     *
     * 全仓四份 escapeHtml 现在语义一致，`test/escape-html.test.mjs` 钉住。
     */
    if (text === null || text === undefined) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  
  // --- Global Listeners ---
  addEventListeners() {
    this.toggleBtn.addEventListener('click', () => this.toggle());
    if (this.closeBtn) this.closeBtn.addEventListener('click', () => this.close());
    
    // Input Today
    if (this.addBtnToday) this.addBtnToday.addEventListener('click', () => this.handleAddTodo('today'));
    if (this.inputToday) {
        this.inputToday.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.handleAddTodo('today');
        });
    }

    // Input Inbox
    if (this.addBtnInbox) this.addBtnInbox.addEventListener('click', () => this.handleAddTodo('inventory'));
    if (this.inputInbox) {
        this.inputInbox.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.handleAddTodo('inventory');
        });
    }
    
    // Legacy Input Support (in case)
    if (this.addBtn && !this.addBtnInbox) {
        this.addBtn.addEventListener('click', () => this.handleAddTodo('inventory'));
    }
    
    if (this.clearCompletedBtn) {
        this.clearCompletedBtn.addEventListener('click', () => this.clearCompleted());
    }
    
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.panel.classList.contains('hidden')) {
        this.close();
      }
    });

    // Pomo Complete Listener
    document.addEventListener('pomodoroComplete', (e) => {
      if (this.activeTaskId && e.detail?.mode === 'work') {
        this.incrementPomodoroCount(this.activeTaskId);
      }
    });
  }

  handleAddTodo(targetType = 'inventory') {
    let inputEl, text;
    
    if (targetType === 'today') {
        inputEl = this.inputToday;
    } else {
        inputEl = this.inputInbox || this.input;
    }
    
    if (!inputEl) return;
    text = inputEl.value;
    
    // Add logic
    if (this.addTodo(text, targetType)) {
      inputEl.value = '';
      inputEl.focus();
    }
  }

  toggle() {
    this.panel.classList.toggle('hidden');
    const isHidden = this.panel.classList.contains('hidden');
    this.toggleBtn.ariaPressed = !isHidden;
    if (!isHidden && this.input) setTimeout(() => this.input.focus(), 100);
  }

  close() {
    this.panel.classList.add('hidden');
    this.toggleBtn.ariaPressed = 'false';
  }

  exposeGlobalAPI() {
    window.TodoList = {
      getActiveTask: () => this.todos.find(t => t.id === this.activeTaskId),
      getActiveTaskId: () => this.activeTaskId,
      incrementPomodoroCount: (id) => this.incrementPomodoroCount(id || this.activeTaskId),
      setActiveTask: (id) => this.setActiveTask(id),
      addInterruption: (id, type) => this.addInterruption(id || this.activeTaskId, type),
      getTodayTasks: () => this.todos.filter(t => t.type === 'today'),
      getAllTasks: () => [...this.todos]
    };
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.todoListInstance = new TodoList();
});
