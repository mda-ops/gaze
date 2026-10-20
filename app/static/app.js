function money(value) {
  return '€' + Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function shortDateLabel(value) {
  const parts = String(value || '').split('-');
  if (parts.length === 3) {
    const month = new Date(`${parts[0]}-${parts[1]}-01T00:00:00`).toLocaleString(undefined, { month: 'short' });
    return `${Number(parts[2])} ${month}`;
  }
  return String(value || '');
}

function platformClass(platform) {
  const label = String(platform || '').toLowerCase();
  if (label.includes('f2f')) return 'platform-f2f';
  if (label.includes('knky') || label.includes('kinky')) return 'platform-knky';
  if (label === 'of' || label.includes('onlyfans') || label.includes('only fans')) return 'platform-of';
  return 'platform-other';
}

function addStackedSegments(bar, row, value) {
  const platforms = Array.isArray(row.platforms) ? row.platforms.filter(item => Number(item.revenue || 0) > 0) : [];
  if (!platforms.length || value <= 0) return;
  bar.classList.add('stacked-bar');
  const stack = document.createElement('div');
  stack.className = 'bar-stack';
  platforms.forEach(item => {
    const segment = document.createElement('span');
    segment.className = `bar-segment ${platformClass(item.platform)}`;
    segment.style.height = `${Math.max(2, Number(item.revenue || 0) / value * 100)}%`;
    segment.title = `${item.platform}: ${money(item.revenue)}`;
    stack.appendChild(segment);
  });
  bar.appendChild(stack);
}

function drawBars(id, rows, labelKey, valueKey, alt, maxOverride) {
  const el = document.getElementById(id);
  if (!el || !rows || !rows.length) return;
  const max = maxOverride || Math.max(...rows.map(r => Number(r[valueKey] || 0)), 1);
  el.innerHTML = '';
  rows.slice(0, 40).forEach(row => {
    const value = Number(row[valueKey] || 0);
    const bar = document.createElement('div');
    bar.className = 'bar' + (alt ? ' alt' : '');
    bar.style.height = Math.max(4, value / max * 235) + 'px';
    bar.dataset.label = `${row[labelKey]}: ${money(value)}`;
    if (id === 'trendChart') {
      addStackedSegments(bar, row, value);
      const valueLabel = document.createElement('span');
      valueLabel.className = 'bar-value';
      valueLabel.textContent = money(value);
      const dateLabel = document.createElement('span');
      dateLabel.className = 'bar-date';
      dateLabel.textContent = shortDateLabel(row[labelKey]);
      bar.appendChild(valueLabel);
      bar.appendChild(dateLabel);
    }
    el.appendChild(bar);
  });
}

function drawTrendComparison(rows, max) {
  const el = document.getElementById('trendChart');
  if (!el || !rows || !rows.length) return;
  const limitedRows = rows.slice(0, 40);
  const overlay = document.createElement('div');
  overlay.className = 'trend-comparison-bars';
  limitedRows.forEach(row => {
    const value = Number(row.revenue || 0);
    const wrap = document.createElement('div');
    wrap.className = 'trend-comparison-slot';
    const bar = document.createElement('div');
    bar.className = 'trend-comparison-bar';
    bar.style.height = Math.max(4, value / max * 235) + 'px';
    bar.dataset.label = `${row.date}: ${money(value)}`;
    const label = document.createElement('span');
    label.className = 'trend-comparison-value';
    label.textContent = money(value);
    wrap.appendChild(bar);
    wrap.appendChild(label);
    overlay.appendChild(wrap);
  });
  el.appendChild(overlay);
}

function drawTrendChart(comparePreviousMonth = false) {
  const current = window.chartData.trend || [];
  const previous = window.chartData.previousMonthTrend || [];
  const maxRows = comparePreviousMonth ? current.concat(previous) : current;
  const max = Math.max(...maxRows.map(row => Number(row.revenue || 0)), 1);
  drawBars('trendChart', current, 'date', 'revenue', false, max);
  if (comparePreviousMonth) {
    drawTrendComparison(previous, max);
  }
}

if (window.chartData) {
  drawTrendChart(false);
  drawBars('platformChart', window.chartData.platform || [], 'platform', 'revenue', true);
}

const trendCompareToggle = document.querySelector('.trend-compare-toggle');
if (trendCompareToggle && window.chartData) {
  trendCompareToggle.addEventListener('click', () => {
    const isActive = trendCompareToggle.classList.toggle('active');
    drawTrendChart(isActive);
    const label = window.chartData.previousMonthLabel || trendCompareToggle.dataset.compareLabel || 'Previous month';
    const compareLabel = trendCompareToggle.dataset.compareLabel || 'Previous period';
    trendCompareToggle.textContent = isActive ? `Hide ${label}` : `Compare to ${compareLabel}`;
    trendCompareToggle.setAttribute('aria-pressed', String(isActive));
  });
}

function syncDateInputsFromRange(range) {
  const selected = range.options[range.selectedIndex];
  if (!selected || selected.textContent.trim() === 'Custom') return;
  const form = range.closest('form');
  const start = form ? form.querySelector('input[name="start"]') : null;
  const end = form ? form.querySelector('input[name="end"]') : null;
  if (start && selected.dataset.start) start.value = selected.dataset.start;
  if (end && selected.dataset.end) end.value = selected.dataset.end;
}

document.querySelectorAll('select[name="range"]').forEach(range => {
  range.addEventListener('change', () => syncDateInputsFromRange(range));
});

document.querySelectorAll('input[name="start"], input[name="end"]').forEach(input => {
  input.addEventListener('change', () => {
    const form = input.closest('form');
    const range = form ? form.querySelector('select[name="range"]') : null;
    if (!range) return;
    const customOption = Array.from(range.options).find(option => option.value === 'Custom' || option.textContent.trim() === 'Custom');
    if (!customOption) return;
    range.value = customOption.value || customOption.textContent.trim();
    range.dispatchEvent(new Event('change', { bubbles: true }));
  });
});

const currentPath = window.location.pathname.replace(/\/$/, '') || '/';
document.querySelectorAll('.sidebar nav a').forEach(link => {
  const linkPath = new URL(link.href).pathname.replace(/\/$/, '') || '/';
  if (linkPath === currentPath) link.classList.add('active');
});

const navGroups = Array.from(document.querySelectorAll('.nav-group'));
const activeLink = document.querySelector('.sidebar nav a.active');
const activeGroup = activeLink ? activeLink.closest('.nav-group') : null;
const savedGroups = new Set((window.localStorage.getItem('revenueAnalyticsOpenNavGroups') || '').split(',').filter(Boolean));
const firstGroup = navGroups[0];

function saveOpenNavGroups() {
  const openNames = navGroups
    .filter(group => group.classList.contains('open'))
    .map(group => group.dataset.navGroup || '')
    .filter(Boolean);
  window.localStorage.setItem('revenueAnalyticsOpenNavGroups', openNames.join(','));
}

function setNavGroup(group, isOpen) {
  if (!group) return;
  group.classList.toggle('open', isOpen);
  const button = group.querySelector('.nav-toggle');
  if (button) button.setAttribute('aria-expanded', String(isOpen));
}

navGroups.forEach(group => {
  const shouldOpen = group === activeGroup || savedGroups.has(group.dataset.navGroup || '');
  setNavGroup(group, shouldOpen);
});
if (!navGroups.some(group => group.classList.contains('open')) && firstGroup) setNavGroup(firstGroup, true);
saveOpenNavGroups();

document.querySelectorAll('.nav-toggle').forEach(button => {
  button.addEventListener('click', () => {
    const group = button.closest('.nav-group');
    setNavGroup(group, !group.classList.contains('open'));
    saveOpenNavGroups();
  });
});

document.querySelectorAll('.nav-group a').forEach(link => {
  link.addEventListener('click', () => {
    const group = link.closest('.nav-group');
    if (group) {
      setNavGroup(group, true);
      saveOpenNavGroups();
    }
  });
});

const profileWrap = document.querySelector('.profile-menu-wrap');
const profileTrigger = document.querySelector('.profile-trigger');
if (profileWrap && profileTrigger) {
  profileTrigger.addEventListener('click', event => {
    event.stopPropagation();
    const isOpen = profileWrap.classList.toggle('open');
    profileTrigger.setAttribute('aria-expanded', String(isOpen));
  });

  document.addEventListener('click', event => {
    if (!profileWrap.contains(event.target)) {
      profileWrap.classList.remove('open');
      profileTrigger.setAttribute('aria-expanded', 'false');
    }
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      profileWrap.classList.remove('open');
      profileTrigger.setAttribute('aria-expanded', 'false');
    }
  });
}

document.querySelectorAll('.password-toggle').forEach(button => {
  button.addEventListener('click', () => {
    const field = button.closest('.password-field');
    const input = field ? field.querySelector('input') : null;
    if (!input) return;
    const isHidden = input.type === 'password';
    input.type = isHidden ? 'text' : 'password';
    button.classList.toggle('is-visible', isHidden);
    button.setAttribute('aria-label', isHidden ? 'Hide password' : 'Show password');
  });
});

document.querySelectorAll('select').forEach(select => {
  if (select.dataset.enhanced === 'true') return;
  select.dataset.enhanced = 'true';
  select.classList.add('enhanced-select-native');

  const wrapper = document.createElement('div');
  wrapper.className = 'lux-select';
  if (select.multiple) wrapper.classList.add('multi');

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'lux-select-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');

  const menu = document.createElement('div');
  menu.className = 'lux-select-menu';
  menu.setAttribute('role', 'listbox');
  if (select.multiple) menu.setAttribute('aria-multiselectable', 'true');

  function selectedText() {
    const selected = Array.from(select.selectedOptions).filter(option => option.value || !select.multiple);
    if (!selected.length) return 'All';
    if (select.multiple && selected.length > 2) return `${selected.length} selected`;
    return selected.map(option => option.textContent.trim()).join(', ');
  }

  function syncButton() {
    trigger.textContent = selectedText();
    menu.querySelectorAll('.lux-select-option').forEach(item => {
      const option = select.options[Number(item.dataset.index)];
      item.classList.toggle('selected', Boolean(option && option.selected));
      item.setAttribute('aria-selected', String(Boolean(option && option.selected)));
      const check = item.querySelector('.lux-select-check');
      if (check) check.setAttribute('aria-hidden', 'true');
    });
  }

  Array.from(select.options).forEach((option, index) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'lux-select-option';
    item.dataset.index = String(index);
    item.setAttribute('role', 'option');
    if (select.multiple) {
      const check = document.createElement('span');
      check.className = 'lux-select-check';
      check.setAttribute('aria-hidden', 'true');
      const text = document.createElement('span');
      text.className = 'lux-select-label';
      text.textContent = option.textContent;
      item.appendChild(check);
      item.appendChild(text);
    } else {
      item.textContent = option.textContent;
    }
    item.addEventListener('click', () => {
      if (select.multiple) {
        if (!option.value) {
          Array.from(select.options).forEach(selectOption => { selectOption.selected = false; });
        } else {
          option.selected = !option.selected;
          if (select.options[0] && !select.options[0].value) select.options[0].selected = false;
        }
      } else {
        select.selectedIndex = index;
        wrapper.classList.remove('open');
        trigger.setAttribute('aria-expanded', 'false');
      }
      select.dispatchEvent(new Event('change', { bubbles: true }));
      syncButton();
    });
    menu.appendChild(item);
  });

  trigger.addEventListener('click', event => {
    event.stopPropagation();
    document.querySelectorAll('.lux-select.open').forEach(openSelect => {
      if (openSelect !== wrapper) {
        openSelect.classList.remove('open');
        const openTrigger = openSelect.querySelector('.lux-select-trigger');
        if (openTrigger) openTrigger.setAttribute('aria-expanded', 'false');
      }
    });
    const isOpen = wrapper.classList.toggle('open');
    trigger.setAttribute('aria-expanded', String(isOpen));
  });

  select.addEventListener('change', syncButton);
  select.parentNode.insertBefore(wrapper, select.nextSibling);
  wrapper.appendChild(trigger);
  wrapper.appendChild(menu);
  syncButton();
});

document.addEventListener('click', () => {
  document.querySelectorAll('.lux-select.open').forEach(wrapper => {
    wrapper.classList.remove('open');
    const trigger = wrapper.querySelector('.lux-select-trigger');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
  });
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    document.querySelectorAll('.lux-select.open').forEach(wrapper => {
      wrapper.classList.remove('open');
      const trigger = wrapper.querySelector('.lux-select-trigger');
      if (trigger) trigger.setAttribute('aria-expanded', 'false');
    });
  }
});

function normaliseTableText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function sortValue(value, type = '') {
  value = normaliseTableText(value);
  if (!value) return { type: 'missing', value: '' };
  if (type === 'number') {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? { type: 'number', value: numeric } : { type: 'missing', value: '' };
  }
  if (type === 'date') {
    const date = Date.parse(value);
    return Number.isFinite(date) ? { type: 'date', value: date } : { type: 'text', value: value.toLowerCase() };
  }
  const numeric = Number(value.replace(/[€,%\s]/g, '').replace(/,/g, ''));
  if (value && Number.isFinite(numeric)) return { type: 'number', value: numeric };
  const date = Date.parse(value);
  if (value && Number.isFinite(date)) return { type: 'date', value: date };
  return { type: 'text', value: value.toLowerCase() };
}

function compareTableValues(a, b, direction) {
  const first = sortValue(a?.dataset.sortValue || a?.textContent, a?.dataset.sortType);
  const second = sortValue(b?.dataset.sortValue || b?.textContent, b?.dataset.sortType);
  // Missing values are unknown, not zero, and stay at the end in either order.
  if (first.type === 'missing') return second.type === 'missing' ? 0 : 1;
  if (second.type === 'missing') return -1;
  let result = 0;
  if (first.type === second.type && first.type !== 'text') {
    result = first.value - second.value;
  } else {
    result = String(first.value).localeCompare(String(second.value), undefined, { numeric: true, sensitivity: 'base' });
  }
  return direction === 'desc' ? -result : result;
}

function shouldFilterColumn(label, values) {
  const key = label.toLowerCase();
  const important = ['creator', 'model', 'chatter', 'tier', 'platform', 'team', 'status', 'transaction type', 'type', 'source', 'last updated', 'updated at', 'date'];
  if (!important.some(part => key.includes(part))) return false;
  return values.length > 1 && values.length <= 100;
}

function enhanceDataTable(table) {
  if (!table || table.dataset.tableEnhanced === 'true') return;
  const headers = Array.from(table.querySelectorAll('thead th'));
  const body = table.querySelector('tbody');
  if (!headers.length || !body) return;
  const originalRows = Array.from(body.querySelectorAll('tr'));
  if (!originalRows.length) return;
  table.dataset.tableEnhanced = 'true';

  const wrapper = document.createElement('div');
  wrapper.className = 'table-tools';
  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'table-search';
  search.placeholder = 'Search table';
  search.setAttribute('aria-label', 'Search table');
  wrapper.appendChild(search);

  const filters = [];
  headers.forEach((header, index) => {
    const label = normaliseTableText(header.textContent);
    const values = Array.from(new Set(originalRows.map(row => normaliseTableText(row.children[index]?.textContent)).filter(Boolean))).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    if (!shouldFilterColumn(label, values)) return;
    const select = document.createElement('select');
    select.className = 'table-filter';
    select.setAttribute('aria-label', `Filter by ${label}`);
    const allOption = document.createElement('option');
    allOption.value = '';
    allOption.textContent = `All ${label}`;
    select.appendChild(allOption);
    values.forEach(value => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      select.appendChild(option);
    });
    select.dataset.column = String(index);
    wrapper.appendChild(select);
    filters.push(select);
  });

  table.parentNode.insertBefore(wrapper, table);

  let sortIndex = -1;
  let sortDirection = null;
  headers.forEach((header, index) => {
    const label = normaliseTableText(header.textContent);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'table-sort';
    button.textContent = label;
    button.setAttribute('aria-label', `Sort by ${label}`);
    header.textContent = '';
    header.appendChild(button);
    button.addEventListener('click', () => {
      if (sortIndex === index) {
        if (sortDirection === 'asc') sortDirection = 'desc';
        else if (sortDirection === 'desc') { sortIndex = -1; sortDirection = null; }
        else sortDirection = 'asc';
      } else {
        sortIndex = index;
        sortDirection = 'asc';
      }
      headers.forEach(th => th.removeAttribute('data-sort'));
      if (sortDirection) header.dataset.sort = sortDirection;
      applyTableState();
    });
  });

  function applyTableState() {
    const term = search.value.trim().toLowerCase();
    const activeFilters = filters
      .map(select => ({ column: Number(select.dataset.column), value: select.value }))
      .filter(item => item.value);
    let rows = originalRows.slice();
    rows.forEach(row => {
      const rowText = normaliseTableText(row.textContent).toLowerCase();
      const matchesSearch = !term || rowText.includes(term);
      const matchesFilters = activeFilters.every(filter => normaliseTableText(row.children[filter.column]?.textContent) === filter.value);
      row.hidden = !(matchesSearch && matchesFilters);
    });
    if (sortIndex >= 0) {
      rows.sort((a, b) => compareTableValues(a.children[sortIndex]?.textContent, b.children[sortIndex]?.textContent, sortDirection));
    }
    rows.forEach(row => body.appendChild(row));
  }

  search.addEventListener('input', applyTableState);
  filters.forEach(select => select.addEventListener('change', applyTableState));
}

document.querySelectorAll('.data-table').forEach(enhanceDataTable);

document.querySelectorAll('.wysiwyg-editor').forEach(editor => {
  const target = document.getElementById(editor.dataset.target || '');
  const sync = () => {
    if (target) target.value = editor.innerHTML;
  };
  editor.addEventListener('input', sync);
  const form = editor.closest('form');
  if (form) form.addEventListener('submit', sync);
});

document.querySelectorAll('.wysiwyg-toolbar button').forEach(button => {
  button.addEventListener('click', () => {
    const toolbar = button.closest('.wysiwyg-toolbar');
    const editor = toolbar ? toolbar.nextElementSibling : null;
    if (!editor || !editor.classList.contains('wysiwyg-editor')) return;
    editor.focus();
    document.execCommand(button.dataset.command, false, button.dataset.value || null);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  });
});
