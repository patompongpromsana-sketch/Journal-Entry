(function(){
  "use strict";

  // ===================================================================
  // ตั้งค่า Supabase ของคุณตรงนี้ (หาได้ที่ Project Settings > API ใน Supabase)
  // ===================================================================
  var SUPABASE_URL = 'https://xwklhkggusvholfdnnbk.supabase.co';
  var SUPABASE_ANON_KEY = 'sb_publishable_faMlHF7cD_CNCxCyQ8j7bA_QZv2eS3B';
  // ===================================================================

  var accountTypeLabels = { cash:'เงินสด', bank:'บัญชีธนาคาร', credit:'บัตรเครดิต', ewallet:'อีวอลเล็ท', other:'อื่นๆ' };
  var assetTypeLabels = { stock:'หุ้น', fund:'กองทุนรวม', crypto:'คริปโต', gold:'ทองคำ', bond:'พันธบัตร/หุ้นกู้', other:'อื่นๆ' };
  var defaultAccounts = [ {name:'เงินสด', type:'cash'}, {name:'บัญชีธนาคาร', type:'bank'} ];
  var defaultCategories = [
    {name:'เงินเดือน', type:'income'}, {name:'รายได้เสริม', type:'income'},
    {name:'อาหาร', type:'expense'}, {name:'เดินทาง', type:'expense'},
    {name:'ที่พัก/บิล', type:'expense'}, {name:'ช้อปปิ้ง', type:'expense'},
    {name:'สุขภาพ', type:'expense'}, {name:'บันเทิง', type:'expense'}, {name:'อื่นๆ', type:'expense'}
  ];

  var state = { accounts:{}, categories:{}, transactions:{}, holdings:{}, investmentTxns:{}, debts:{}, debtPayments:{}, budgets:{}, recurringTemplates:{},
    ready: { accounts:false, categories:false, transactions:false, holdings:false, investmentTxns:false, debts:false, debtPayments:false, budgets:false, recurringTemplates:false } };
  var currentTab = 'dashboard';
  var seedAttempted = false;
  var recurringProcessed = false;
  var txFilter = { month: todayISO().slice(0,7), type:'all', accountId:'all' };
  var selectedTrendMonth = todayISO().slice(0,7);
  var selectedDebtId = null;

  var tabContentEl = document.getElementById('tabContent');
  var syncStatusEl = document.getElementById('syncStatus');
  var modalOverlayEl = document.getElementById('modalOverlay');
  var modalContentEl = document.getElementById('modalContent');
  var fabWrapEl = document.getElementById('fabWrap');

  // ---------- helpers ----------
  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, function(ch){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch];
    });
  }
  function fmtMoney(n) {
    n = Number(n) || 0;
    var sign = n < 0 ? '-' : '';
    return sign + '฿' + Math.abs(n).toLocaleString('th-TH', {minimumFractionDigits:2, maximumFractionDigits:2});
  }
  function fmtQty(n) {
    n = Number(n) || 0;
    return n.toLocaleString('th-TH', {maximumFractionDigits:4});
  }
  function fmtDateShort(iso) {
    var d = new Date(iso);
    return d.toLocaleDateString('th-TH', {day:'numeric', month:'short'});
  }
  function todayISO() {
    var d = new Date();
    var tz = d.getTimezoneOffset() * 60000;
    return new Date(d - tz).toISOString().slice(0,10);
  }
  function monthKey(dateStr) { return String(dateStr || '').slice(0,7); }
  function shiftMonth(delta) {
    var parts = txFilter.month.split('-').map(Number);
    var d = new Date(parts[0], parts[1]-1+delta, 1);
    txFilter.month = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0');
  }
  function csvEscape(v) {
    var s = String(v == null ? '' : v);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g,'""') + '"';
    return s;
  }
  function allReady() {
    return Object.keys(state.ready).every(function(k){ return state.ready[k]; });
  }

  // ---------- derived values ----------
  function accountBalance(accId) {
    var bal = 0;
    Object.values(state.transactions).forEach(function(t){
      if (t.accountId !== accId) return;
      bal += t.type === 'income' ? Number(t.amount) : -Number(t.amount);
    });
    return bal;
  }
  function totalCash() {
    return Object.keys(state.accounts).reduce(function(sum,id){ return sum + accountBalance(id); }, 0);
  }
  function holdingValue(h) { return (Number(h.quantity)||0) * (Number(h.currentPrice)||0); }
  function holdingCost(h) { return (Number(h.quantity)||0) * (Number(h.avgCost)||0); }
  function totalInvestmentValue() {
    return Object.values(state.holdings).reduce(function(s,h){ return s + holdingValue(h); }, 0);
  }
  function totalInvestmentCost() {
    return Object.values(state.holdings).reduce(function(s,h){ return s + holdingCost(h); }, 0);
  }
  function transactionsForMonth(mKey) {
    return Object.values(state.transactions).filter(function(t){ return monthKey(t.date) === mKey; });
  }

  function paymentsForDebt(debtId) {
    return Object.values(state.debtPayments).filter(function(p){ return p.debtId === debtId; });
  }
  function debtPaidPrincipal(debtId) {
    return paymentsForDebt(debtId).reduce(function(s,p){ return s + Number(p.principal||0); }, 0);
  }
  function debtPaidInterest(debtId) {
    return paymentsForDebt(debtId).reduce(function(s,p){ return s + Number(p.interest||0); }, 0);
  }
  function debtRemaining(debt) {
    return Math.max(0, Number(debt.principal||0) - debtPaidPrincipal(debt.id));
  }
  function totalDebtRemaining() {
    return Object.values(state.debts).reduce(function(s,d){ return s + debtRemaining(d); }, 0);
  }
  function debtYearlyBreakdown(debtId) {
    var byYear = {};
    paymentsForDebt(debtId).forEach(function(p){
      var y = String(p.date || '').slice(0,4);
      if (!byYear[y]) byYear[y] = { year:y, principal:0, interest:0 };
      byYear[y].principal += Number(p.principal||0);
      byYear[y].interest += Number(p.interest||0);
    });
    return Object.values(byYear).sort(function(a,b){ return b.year.localeCompare(a.year); });
  }

  // ---------- Supabase-backed store (single JSON document per signed-in user) ----------
  var supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  var currentUserId = null;
  var currentUserEmail = '';
  var realtimeChannel = null;
  var saveTimer = null;

  var Store = {
    collections: ['accounts','categories','transactions','holdings','investmentTxns','debts','debtPayments','budgets','recurringTemplates'],
    add: function(name, obj) {
      var id = 'id_' + Date.now() + '_' + Math.random().toString(36).slice(2,8);
      state[name][id] = Object.assign({id:id}, obj);
      scheduleSave();
      onDataChange(name);
      return Promise.resolve(id);
    },
    update: function(name, id, patch) {
      if (state[name][id]) {
        Object.assign(state[name][id], patch);
        scheduleSave();
        onDataChange(name);
      }
      return Promise.resolve();
    },
    remove: function(name, id) {
      delete state[name][id];
      scheduleSave();
      onDataChange(name);
      return Promise.resolve();
    }
  };

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(doSave, 500);
  }

  function doSave() {
    if (!currentUserId) return;
    var payload = {};
    Store.collections.forEach(function(name){ payload[name] = state[name]; });
    supabaseClient.from('user_data').upsert({ id: currentUserId, data: payload, updated_at: new Date().toISOString() }).then(function(res){
      if (res.error) console.error('save error', res.error);
    });
  }

  function loadUserData(userId) {
    return supabaseClient.from('user_data').select('data').eq('id', userId).maybeSingle().then(function(res){
      if (res.error) { console.error('load error', res.error); return; }
      var payload = res.data && res.data.data;
      Store.collections.forEach(function(name){ state[name] = (payload && payload[name]) || {}; state.ready[name] = true; });
      onDataChange('all');
    });
  }

  function subscribeRealtime(userId) {
    if (realtimeChannel) supabaseClient.removeChannel(realtimeChannel);
    realtimeChannel = supabaseClient.channel('user_data_' + userId)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'user_data', filter: 'id=eq.' + userId }, function(payload){
        var newData = payload.new && payload.new.data;
        if (!newData) return;
        Store.collections.forEach(function(name){ state[name] = newData[name] || {}; });
        renderTab();
      })
      .subscribe();
  }

  function updateSyncStatus() {
    syncStatusEl.textContent = currentUserEmail ? ('ซิงค์แล้ว · ' + currentUserEmail) : 'ยังไม่ได้เข้าสู่ระบบ';
  }

  function onDataChange() {
    maybeSeedDefaults();
    maybeProcessRecurring();
    renderTab();
  }

  function maybeSeedDefaults() {
    if (seedAttempted) return;
    if (!state.ready.accounts || !state.ready.categories) return;
    seedAttempted = true;
    if (Object.keys(state.accounts).length > 0 || Object.keys(state.categories).length > 0) return;
    defaultAccounts.forEach(function(a){ Store.add('accounts', a); });
    defaultCategories.forEach(function(c){ Store.add('categories', c); });
  }

  function daysInMonth(y, m0) { return new Date(y, m0 + 1, 0).getDate(); }
  function advanceMonthly(dateStr, dayOfMonth) {
    var d = new Date(dateStr);
    var nextMonthIndex = d.getMonth() + 1;
    var targetYear = d.getFullYear() + Math.floor(nextMonthIndex / 12);
    var targetMonth0 = nextMonthIndex % 12;
    var day = Math.min(Number(dayOfMonth) || d.getDate(), daysInMonth(targetYear, targetMonth0));
    return targetYear + '-' + String(targetMonth0 + 1).padStart(2,'0') + '-' + String(day).padStart(2,'0');
  }

  function maybeProcessRecurring() {
    if (recurringProcessed) return;
    if (!state.ready.recurringTemplates || !state.ready.accounts || !state.ready.categories) return;
    recurringProcessed = true;
    var today = todayISO();
    Object.values(state.recurringTemplates).forEach(function(tpl){
      if (tpl.active === false || !tpl.nextDate) return;
      var nextDate = tpl.nextDate;
      var guard = 0;
      while (nextDate <= today && guard < 24) {
        Store.add('transactions', { type: tpl.type, amount: Number(tpl.amount), accountId: tpl.accountId, categoryId: tpl.categoryId, date: nextDate, note: (tpl.note || '') + ' (อัตโนมัติ)' });
        nextDate = advanceMonthly(nextDate, tpl.dayOfMonth);
        guard++;
      }
      if (nextDate !== tpl.nextDate) Store.update('recurringTemplates', tpl.id, { nextDate: nextDate });
    });
  }

  // ---------- rendering ----------
  function switchTab(tab) {
    currentTab = tab;
    if (tab === 'debts') selectedDebtId = null;
    document.querySelectorAll('.tab-btn').forEach(function(b){
      b.classList.toggle('active', b.dataset.tab === tab);
    });
    fabWrapEl.classList.toggle('hidden', tab === 'settings');
    renderTab();
  }

  function renderTab() {
    if (!allReady()) {
      tabContentEl.innerHTML = '<div class="card"><div class="empty-note">กำลังโหลดข้อมูล...</div></div>';
      return;
    }
    if (currentTab === 'dashboard') tabContentEl.innerHTML = renderDashboard();
    else if (currentTab === 'transactions') tabContentEl.innerHTML = renderTransactions();
    else if (currentTab === 'investments') tabContentEl.innerHTML = renderInvestments();
    else if (currentTab === 'debts') tabContentEl.innerHTML = renderDebts();
    else tabContentEl.innerHTML = renderSettings();
  }

  function txRow(t) {
    var cat = state.categories[t.categoryId];
    var acc = state.accounts[t.accountId];
    var sign = t.type === 'income' ? '+' : '-';
    var cls = t.type === 'income' ? 'income-text' : 'expense-text';
    var subParts = [];
    if (acc) subParts.push(escapeHtml(acc.name));
    if (t.note) subParts.push(escapeHtml(t.note));
    return '' +
      '<div class="tx-row" data-action="edit-tx" data-id="' + t.id + '">' +
        '<div class="tx-main">' +
          '<div class="tx-cat">' + escapeHtml(cat ? cat.name : 'ไม่ระบุหมวด') + '</div>' +
          '<div class="tx-sub">' + subParts.join(' · ') + '</div>' +
        '</div>' +
        '<div class="tx-side">' +
          '<div class="tx-amt ' + cls + '">' + sign + fmtMoney(Number(t.amount)) + '</div>' +
          '<div class="tx-date">' + fmtDateShort(t.date) + '</div>' +
        '</div>' +
      '</div>';
  }

  function renderDashboard() {
    var cash = totalCash();
    var invValue = totalInvestmentValue();
    var invCost = totalInvestmentCost();
    var gain = invValue - invCost;
    var gainPct = invCost > 0 ? (gain / invCost * 100) : 0;
    var debtRemainingTotal = totalDebtRemaining();
    var netWorth = cash + invValue - debtRemainingTotal;

    var monthTx = transactionsForMonth(todayISO().slice(0,7));
    var income = monthTx.filter(function(t){ return t.type==='income'; }).reduce(function(s,t){ return s+Number(t.amount); },0);
    var expense = monthTx.filter(function(t){ return t.type==='expense'; }).reduce(function(s,t){ return s+Number(t.amount); },0);

    var recent = Object.values(state.transactions).sort(function(a,b){ return (b.date||'').localeCompare(a.date||''); }).slice(0,5);

    var html = '';
    html += '<div class="card hero-card">' +
      '<div class="hero-label">มูลค่าสุทธิ</div>' +
      '<div class="hero-value">' + fmtMoney(netWorth) + '</div>' +
      '<div class="hero-split">' +
        '<div><span class="dot dot-cash"></span>เงินสด/บัญชี ' + fmtMoney(cash) + '</div>' +
        '<div><span class="dot dot-invest"></span>การลงทุน ' + fmtMoney(invValue) + '</div>' +
        (Object.keys(state.debts).length ? '<div><span class="dot dot-debt"></span>หนี้คงเหลือ -' + fmtMoney(debtRemainingTotal) + '</div>' : '') +
      '</div></div>';

    html += '<div class="grid-2">' +
      '<div class="card stat-card"><div class="stat-label">รายรับเดือนนี้</div><div class="stat-value income-text">' + fmtMoney(income) + '</div></div>' +
      '<div class="card stat-card"><div class="stat-label">รายจ่ายเดือนนี้</div><div class="stat-value expense-text">' + fmtMoney(expense) + '</div></div>' +
    '</div>';

    html += renderExpenseTrendCard();
    html += renderBudgetCard();

    html += '<div class="card">' +
      '<div class="card-title-row">' +
        '<div class="card-title">การลงทุน</div>' +
        '<div class="' + (gain>=0?'income-text':'expense-text') + ' small-bold">' + (gain>=0?'+':'') + fmtMoney(gain) + ' (' + gainPct.toFixed(1) + '%)</div>' +
      '</div>' +
      (Object.keys(state.holdings).length ? '' : '<div class="empty-note">ยังไม่มีการลงทุนที่บันทึกไว้</div>') +
    '</div>';

    html += renderDebtSummaryCard();

    html += '<div class="card">' +
      '<div class="card-title-row"><div class="card-title">รายการล่าสุด</div>' +
      '<button class="link-btn" data-action="go-tab" data-tab="transactions">ดูทั้งหมด</button></div>' +
      (recent.length ? recent.map(txRow).join('') : '<div class="empty-note">ยังไม่มีรายการ</div>') +
    '</div>';

    return html;
  }

  function renderDebtSummaryCard() {
    var debts = Object.values(state.debts);
    if (!debts.length) return '';
    var totalRemaining = totalDebtRemaining();
    var rows = debts.map(function(d){
      var paid = debtPaidPrincipal(d.id);
      var pct = Number(d.principal) > 0 ? Math.min(100, paid / Number(d.principal) * 100) : 0;
      return '<div class="debt-mini-row">' +
        '<div class="debt-mini-name">' + escapeHtml(d.name) + '</div>' +
        '<div class="progress-track"><div class="progress-fill" style="width:' + pct.toFixed(0) + '%"></div></div>' +
        '<div class="debt-mini-val">' + fmtMoney(debtRemaining(d)) + '</div>' +
      '</div>';
    }).join('');
    return '<div class="card">' +
      '<div class="card-title-row"><div class="card-title">หนี้</div>' +
      '<div class="expense-text small-bold">-' + fmtMoney(totalRemaining) + '</div></div>' +
      rows +
    '</div>';
  }

  var trendPalette = ['#6B7A4A', '#B5674A', '#C98C4A', '#6E8299', '#8F6B7A', '#46512F'];
  var trendOtherColor = '#8C8467';

  function lastNMonths(n) {
    var out = [];
    var now = new Date();
    for (var i = n - 1; i >= 0; i--) {
      var dt = new Date(now.getFullYear(), now.getMonth() - i, 1);
      out.push(dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0'));
    }
    return out;
  }

  function monthlyExpenseByCategory(months) {
    var perMonth = {};
    months.forEach(function(m){ perMonth[m] = {}; });
    Object.values(state.transactions).forEach(function(t){
      if (t.type !== 'expense') return;
      var mk = monthKey(t.date);
      if (!perMonth[mk]) return;
      perMonth[mk][t.categoryId] = (perMonth[mk][t.categoryId] || 0) + Number(t.amount);
    });
    return perMonth;
  }

  function topCategoriesAcross(perMonth, months, limit) {
    var totals = {};
    months.forEach(function(m){
      Object.keys(perMonth[m]).forEach(function(catId){
        totals[catId] = (totals[catId] || 0) + perMonth[m][catId];
      });
    });
    return Object.keys(totals).sort(function(a,b){ return totals[b] - totals[a]; }).slice(0, limit);
  }

  function renderExpenseTrendCard() {
    var months = lastNMonths(6);
    var perMonth = monthlyExpenseByCategory(months);
    var topCats = topCategoriesAcross(perMonth, months, trendPalette.length);
    var catList = topCats.map(function(id, idx){
      return { id: id, name: (state.categories[id] && state.categories[id].name) || 'ไม่ระบุ', color: trendPalette[idx] };
    });

    var monthTotals = months.map(function(m){
      return Object.keys(perMonth[m]).reduce(function(s,catId){ return s + perMonth[m][catId]; }, 0);
    });
    var hasAnyData = monthTotals.some(function(v){ return v > 0; });
    var maxTotal = Math.max.apply(null, [1].concat(monthTotals));

    var chartW = 320, chartH = 110, gap = 10;
    var barW = (chartW - gap * (months.length - 1)) / months.length;

    var bars = '', xLabels = '';
    months.forEach(function(m, i){
      var x = i * (barW + gap);
      var topSum = catList.reduce(function(s,cat){ return s + (perMonth[m][cat.id] || 0); }, 0);
      var otherAmt = monthTotals[i] - topSum;
      var yCursor = chartH;
      var segs = '';
      catList.forEach(function(cat){
        var amt = perMonth[m][cat.id] || 0;
        if (amt <= 0) return;
        var h = maxTotal > 0 ? (amt / maxTotal * chartH) : 0;
        yCursor -= h;
        segs += '<rect x="' + x.toFixed(1) + '" y="' + yCursor.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + h.toFixed(1) + '" fill="' + cat.color + '"/>';
      });
      if (otherAmt > 0.01) {
        var oh = maxTotal > 0 ? (otherAmt / maxTotal * chartH) : 0;
        yCursor -= oh;
        segs += '<rect x="' + x.toFixed(1) + '" y="' + yCursor.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + oh.toFixed(1) + '" fill="' + trendOtherColor + '"/>';
      }
      var isSel = m === selectedTrendMonth;
      bars += '<g data-action="select-trend-month" data-month="' + m + '" style="cursor:pointer;opacity:' + (isSel ? '1' : '0.7') + '">' +
        '<rect x="' + x.toFixed(1) + '" y="0" width="' + barW.toFixed(1) + '" height="' + chartH + '" fill="transparent"/>' +
        segs +
        (isSel ? '<rect x="' + x.toFixed(1) + '" y="' + (chartH + 4) + '" width="' + barW.toFixed(1) + '" height="3" rx="1.5" fill="var(--brand)"/>' : '') +
      '</g>';
      var lbl = new Date(m + '-01').toLocaleDateString('th-TH', {month:'short'});
      xLabels += '<text x="' + (x + barW/2).toFixed(1) + '" y="' + (chartH + 18) + '" text-anchor="middle" font-size="11" fill="var(--muted)">' + lbl + '</text>';
    });

    var svg = '<svg viewBox="0 0 ' + chartW + ' ' + (chartH + 24) + '" width="100%" height="' + (chartH + 24) + '" role="img" aria-label="กราฟแนวโน้มรายจ่ายตามหมวด 6 เดือนล่าสุด">' + bars + xLabels + '</svg>';

    var legend = catList.map(function(cat){
      return '<div class="legend-item"><span class="legend-dot" style="background:' + cat.color + '"></span>' + escapeHtml(cat.name) + '</div>';
    }).join('') + (hasAnyData ? '<div class="legend-item"><span class="legend-dot" style="background:' + trendOtherColor + '"></span>อื่นๆ</div>' : '');

    var selCats = perMonth[selectedTrendMonth] || {};
    var detailRows = Object.keys(selCats).map(function(catId){
      return { name: (state.categories[catId] && state.categories[catId].name) || 'ไม่ระบุหมวด', amt: selCats[catId] };
    }).sort(function(a,b){ return b.amt - a.amt; });
    var maxDetail = Math.max.apply(null, [1].concat(detailRows.map(function(r){ return r.amt; })));
    var selLabel = new Date(selectedTrendMonth + '-01').toLocaleDateString('th-TH', {month:'long', year:'numeric'});

    var detailHtml = detailRows.length ? detailRows.map(function(r){
      return '<div class="bar-row">' +
        '<div class="bar-row-label">' + escapeHtml(r.name) + '</div>' +
        '<div class="bar-track"><div class="bar-fill" style="width:' + (r.amt/maxDetail*100).toFixed(0) + '%"></div></div>' +
        '<div class="bar-row-amt">' + fmtMoney(r.amt) + '</div>' +
      '</div>';
    }).join('') : '<div class="empty-note">ไม่มีรายจ่ายเดือนนี้</div>';

    if (!hasAnyData) {
      return '<div class="card"><div class="card-title">แนวโน้มรายจ่ายตามหมวด</div><div class="empty-note">ยังไม่มีข้อมูลรายจ่ายให้แสดงแนวโน้ม</div></div>';
    }

    return '<div class="card">' +
      '<div class="card-title">แนวโน้มรายจ่ายตามหมวด (6 เดือนล่าสุด)</div>' +
      '<div class="trend-chart-wrap">' + svg + '</div>' +
      '<div class="legend-row">' + legend + '</div>' +
      '<div class="trend-detail"><div class="trend-detail-title">รายละเอียด · ' + selLabel + '</div>' + detailHtml + '</div>' +
    '</div>';
  }

  function renderBudgetCard() {
    var budgets = Object.values(state.budgets);
    if (!budgets.length) return '';
    var monthTx = transactionsForMonth(todayISO().slice(0,7)).filter(function(t){ return t.type==='expense'; });
    var spentByCategory = {};
    monthTx.forEach(function(t){ spentByCategory[t.categoryId] = (spentByCategory[t.categoryId] || 0) + Number(t.amount); });

    var rows = budgets.map(function(b){
      var spent = spentByCategory[b.categoryId] || 0;
      var amount = Number(b.amount) || 0;
      var pct = amount > 0 ? spent / amount * 100 : 0;
      var catName = (state.categories[b.categoryId] && state.categories[b.categoryId].name) || 'ไม่ระบุหมวด';
      var barClass = pct >= 100 ? 'budget-over' : (pct >= 80 ? 'budget-warn' : 'budget-ok');
      return { catName: catName, spent: spent, amount: amount, pct: Math.min(100, pct), over: spent > amount };
    }).sort(function(a,b){ return b.pct - a.pct; });

    var rowsHtml = rows.map(function(r){
      var barClass = r.pct >= 100 ? 'budget-over' : (r.pct >= 80 ? 'budget-warn' : 'budget-ok');
      return '<div class="budget-row">' +
        '<div class="budget-row-top"><span>' + escapeHtml(r.catName) + '</span>' +
        '<span class="' + (r.over ? 'expense-text' : '') + '">' + fmtMoney(r.spent) + ' / ' + fmtMoney(r.amount) + '</span></div>' +
        '<div class="progress-track"><div class="progress-fill ' + barClass + '" style="width:' + r.pct.toFixed(0) + '%"></div></div>' +
      '</div>';
    }).join('');

    return '<div class="card"><div class="card-title">งบประมาณเดือนนี้</div>' + rowsHtml + '</div>';
  }

  function renderTransactions() {
    var monthLabel = new Date(txFilter.month + '-01').toLocaleDateString('th-TH', {month:'long', year:'numeric'});
    var list = transactionsForMonth(txFilter.month);
    if (txFilter.type !== 'all') list = list.filter(function(t){ return t.type === txFilter.type; });
    if (txFilter.accountId !== 'all') list = list.filter(function(t){ return t.accountId === txFilter.accountId; });
    list.sort(function(a,b){ return (b.date||'').localeCompare(a.date||''); });

    var income = list.filter(function(t){ return t.type==='income'; }).reduce(function(s,t){ return s+Number(t.amount); },0);
    var expense = list.filter(function(t){ return t.type==='expense'; }).reduce(function(s,t){ return s+Number(t.amount); },0);

    var accOptions = Object.values(state.accounts).map(function(a){
      return '<option value="' + a.id + '"' + (txFilter.accountId===a.id?' selected':'') + '>' + escapeHtml(a.name) + '</option>';
    }).join('');

    var html = '';
    html += '<div class="month-nav">' +
      '<button class="icon-btn" data-action="month-prev">‹</button>' +
      '<div class="month-label">' + monthLabel + '</div>' +
      '<button class="icon-btn" data-action="month-next">›</button>' +
    '</div>';
    html += '<div class="grid-2">' +
      '<div class="card stat-card"><div class="stat-label">รายรับ</div><div class="stat-value income-text">' + fmtMoney(income) + '</div></div>' +
      '<div class="card stat-card"><div class="stat-label">รายจ่าย</div><div class="stat-value expense-text">' + fmtMoney(expense) + '</div></div>' +
    '</div>';
    html += '<div class="filter-row">' +
      '<select class="select-sm" data-action="filter-type">' +
        '<option value="all"' + (txFilter.type==='all'?' selected':'') + '>ทุกประเภท</option>' +
        '<option value="income"' + (txFilter.type==='income'?' selected':'') + '>รายรับ</option>' +
        '<option value="expense"' + (txFilter.type==='expense'?' selected':'') + '>รายจ่าย</option>' +
      '</select>' +
      '<select class="select-sm" data-action="filter-account">' +
        '<option value="all"' + (txFilter.accountId==='all'?' selected':'') + '>ทุกบัญชี</option>' + accOptions +
      '</select>' +
    '</div>';
    html += '<div class="card list-card">' + (list.length ? list.map(txRow).join('') : '<div class="empty-note">ไม่มีรายการในเดือนนี้</div>') + '</div>';
    return html;
  }

  function holdingCard(h) {
    var val = holdingValue(h);
    var cost = holdingCost(h);
    var gain = val - cost;
    var gainPct = cost > 0 ? gain/cost*100 : 0;
    return '' +
      '<div class="card holding-card">' +
        '<div class="holding-top" data-action="edit-holding" data-id="' + h.id + '">' +
          '<div><div class="holding-name">' + escapeHtml(h.symbol) + '<span class="tag">' + (assetTypeLabels[h.assetType]||'อื่นๆ') + '</span></div>' +
          '<div class="holding-sub">' + escapeHtml(h.name||'') + '</div></div>' +
          '<div class="holding-value-col"><div class="holding-value">' + fmtMoney(val) + '</div>' +
          '<div class="' + (gain>=0?'income-text':'expense-text') + ' small-bold">' + (gain>=0?'+':'') + fmtMoney(gain) + ' (' + gainPct.toFixed(1) + '%)</div></div>' +
        '</div>' +
        '<div class="holding-meta">' +
          '<span>จำนวน ' + fmtQty(h.quantity) + '</span>' +
          '<span>ต้นทุนเฉลี่ย ' + fmtMoney(h.avgCost) + '</span>' +
          '<span>ราคาล่าสุด ' + fmtMoney(h.currentPrice) + '</span>' +
        '</div>' +
        '<div class="holding-actions">' +
          '<button class="chip-btn" data-action="update-price" data-id="' + h.id + '">อัปเดตราคา</button>' +
          '<button class="chip-btn" data-action="record-invest-tx" data-id="' + h.id + '">ซื้อ/ขาย/ปันผล</button>' +
        '</div>' +
      '</div>';
  }

  function renderInvestments() {
    var holdings = Object.values(state.holdings).sort(function(a,b){ return holdingValue(b) - holdingValue(a); });
    var totalVal = totalInvestmentValue();
    var totalCost = totalInvestmentCost();
    var gain = totalVal - totalCost;
    var gainPct = totalCost > 0 ? gain/totalCost*100 : 0;

    var html = '';
    html += '<div class="card hero-card invest-hero">' +
      '<div class="hero-label">มูลค่าการลงทุนรวม</div>' +
      '<div class="hero-value">' + fmtMoney(totalVal) + '</div>' +
      '<div class="' + (gain>=0?'income-text':'expense-text') + ' small-bold">' + (gain>=0?'+':'') + fmtMoney(gain) + ' (' + (gainPct>=0?'+':'') + gainPct.toFixed(1) + '%) จากต้นทุน ' + fmtMoney(totalCost) + '</div>' +
    '</div>';
    html += '<div class="card-title-row list-header"><div class="card-title">รายการลงทุน</div>' +
      '<button class="link-btn" data-action="add-holding">+ เพิ่มรายการ</button></div>';
    html += holdings.length ? holdings.map(holdingCard).join('') : '<div class="card"><div class="empty-note">ยังไม่มีการลงทุน แตะ "+ เพิ่มรายการ" เพื่อเริ่มบันทึก</div></div>';
    return html;
  }

  function fmtDateFull(iso) {
    return new Date(iso).toLocaleDateString('th-TH', {day:'numeric', month:'short', year:'numeric'});
  }

  function debtCard(d) {
    var paid = debtPaidPrincipal(d.id);
    var remaining = debtRemaining(d);
    var pct = Number(d.principal) > 0 ? Math.min(100, paid / Number(d.principal) * 100) : 0;
    return '<div class="card debt-card" data-action="view-debt" data-id="' + d.id + '">' +
      '<div class="debt-card-top">' +
        '<div class="debt-name">' + escapeHtml(d.name) + '</div>' +
        '<div class="debt-remaining">' + fmtMoney(remaining) + '<span class="debt-remaining-label">คงเหลือ</span></div>' +
      '</div>' +
      '<div class="progress-track"><div class="progress-fill" style="width:' + pct.toFixed(0) + '%"></div></div>' +
      '<div class="debt-meta"><span>ยอดกู้ ' + fmtMoney(d.principal) + '</span><span>ผ่อนแล้ว ' + pct.toFixed(0) + '%</span></div>' +
    '</div>';
  }

  function paymentRow(p) {
    var total = Number(p.principal||0) + Number(p.interest||0);
    var subParts = ['เงินต้น ' + fmtMoney(p.principal) + ' · ดอกเบี้ย ' + fmtMoney(p.interest)];
    if (p.note) subParts.push(escapeHtml(p.note));
    return '<div class="tx-row" data-action="edit-payment" data-id="' + p.id + '">' +
      '<div class="tx-main"><div class="tx-cat">' + fmtDateFull(p.date) + '</div>' +
      '<div class="tx-sub">' + subParts.join(' · ') + '</div></div>' +
      '<div class="tx-side"><div class="tx-amt">' + fmtMoney(total) + '</div></div>' +
    '</div>';
  }

  function renderDebtList() {
    var debts = Object.values(state.debts);
    var html = '<div class="card-title-row list-header"><div class="card-title">หนี้ของฉัน</div>' +
      '<button class="link-btn" data-action="add-debt">+ เพิ่มหนี้</button></div>';
    if (!debts.length) {
      html += '<div class="card">' +
        '<div class="empty-note">ยังไม่มีข้อมูลหนี้ แตะ "+ เพิ่มหนี้" เพื่อเริ่มบันทึกเอง</div>' +
        '<button class="secondary-btn full-btn" data-action="import-house-loan">นำเข้าข้อมูลผ่อนบ้านจากไฟล์ที่แนบไว้</button>' +
      '</div>';
      return html;
    }
    html += debts.map(debtCard).join('');
    return html;
  }

  function renderDebtDetail(debt) {
    var paidP = debtPaidPrincipal(debt.id);
    var paidI = debtPaidInterest(debt.id);
    var remaining = debtRemaining(debt);
    var pct = Number(debt.principal) > 0 ? Math.min(100, paidP / Number(debt.principal) * 100) : 0;
    var years = debtYearlyBreakdown(debt.id);
    var payments = paymentsForDebt(debt.id).sort(function(a,b){ return (b.date||'').localeCompare(a.date||''); });

    var html = '';
    html += '<div class="detail-nav"><button class="link-btn" data-action="back-to-debts">‹ หนี้ทั้งหมด</button>' +
      '<button class="icon-btn" data-action="edit-debt" data-id="' + debt.id + '">✎</button></div>';

    html += '<div class="card hero-card">' +
      '<div class="hero-label">' + escapeHtml(debt.name) + ' · คงเหลือ</div>' +
      '<div class="hero-value expense-text">' + fmtMoney(remaining) + '</div>' +
      '<div class="progress-track" style="margin-top:10px"><div class="progress-fill" style="width:' + pct.toFixed(0) + '%"></div></div>' +
      '<div class="hero-split"><div>ยอดกู้ตั้งต้น ' + fmtMoney(debt.principal) + '</div><div>ผ่อนไปแล้ว ' + pct.toFixed(0) + '% (' + fmtMoney(paidP+paidI) + ')</div></div>' +
    '</div>';

    html += '<div class="card">' +
      '<div class="card-title">สรุปรายปี (สำหรับยื่นภาษี)</div>' +
      '<div class="tax-note">ดอกเบี้ยเงินกู้ยืมเพื่อที่อยู่อาศัยใช้ลดหย่อนภาษีได้ตามเงื่อนไขกรมสรรพากร (ปัจจุบันสูงสุด 100,000 บาท/ปี) ควรตรวจสอบกับหนังสือรับรองดอกเบี้ยจากธนาคารและผู้เชี่ยวชาญด้านภาษีอีกครั้งก่อนยื่นจริง</div>' +
      (years.length ? '<div class="year-table">' +
        '<div class="year-row year-header"><span>ปี</span><span>เงินต้น</span><span>ดอกเบี้ย</span><span>รวม</span></div>' +
        years.map(function(y){
          return '<div class="year-row"><span>' + y.year + '</span><span>' + fmtMoney(y.principal) + '</span><span class="expense-text">' + fmtMoney(y.interest) + '</span><span>' + fmtMoney(y.principal + y.interest) + '</span></div>';
        }).join('') +
      '</div>' : '<div class="empty-note">ยังไม่มีรายการผ่อนชำระ</div>') +
    '</div>';

    html += '<div class="card-title-row list-header"><div class="card-title">ประวัติการผ่อนชำระ</div>' +
      '<button class="link-btn" data-action="add-payment" data-id="' + debt.id + '">+ บันทึก</button></div>';
    html += '<div class="card list-card">' + (payments.length ? payments.map(paymentRow).join('') : '<div class="empty-note">ยังไม่มีรายการ</div>') + '</div>';

    return html;
  }

  function renderDebts() {
    if (selectedDebtId && state.debts[selectedDebtId]) return renderDebtDetail(state.debts[selectedDebtId]);
    selectedDebtId = null;
    return renderDebtList();
  }

  // Extracted from the user's uploaded ผ่อนบ้าน.xlsx (verified against the sheet's own
  // totals: principal 156,189.47 / interest 328,910.53 / remaining 1,643,810.53 all matched).
  var houseLoanSeedPayments = [
    ['2022-12-31', 22067.22, 37332.78, 'ยอดรวมช่วงเริ่มกู้ 6 เดือนแรก (ก.ค.-ธ.ค. 2565) จากไฟล์เดิม'],
    ['2023-01-30', 3700, 6200, ''], ['2023-02-28', 3485.45, 6414.55, ''], ['2023-03-30', 3277.29, 6622.71, ''],
    ['2023-04-30', 3023.2, 6876.8, ''], ['2023-05-30', 3228.34, 6671.66, ''], ['2023-06-30', 2579.42, 7320.58, ''],
    ['2023-07-30', 2599.78, 7300.22, ''], ['2023-08-30', 2367.59, 7532.41, ''], ['2023-09-30', 2365.74, 7534.26, ''],
    ['2023-10-30', 2400, 7500, ''], ['2023-11-30', 2026.22, 7873.78, ''], ['2023-12-30', 2000, 7900, ''],
    ['2024-01-30', 2045.65, 7854.35, ''], ['2024-02-29', 2307.93, 7592.07, ''], ['2024-03-30', 2317.98, 7582.02, ''],
    ['2024-04-30', 2087.59, 7812.41, ''], ['2024-05-30', 2693.91, 7206.09, ''], ['2024-06-30', 2465.26, 7434.74, ''],
    ['2024-07-30', 2715.32, 7184.68, ''], ['2024-08-30', 2487.49, 7412.51, ''], ['2024-09-30', 2498.15, 7401.85, ''],
    ['2024-10-30', 2761.45, 7138.55, ''], ['2024-11-30', 2593.77, 7306.23, ''], ['2024-12-30', 2840.12, 7059.88, ''],
    ['2025-01-30', 2616.84, 7283.16, ''], ['2025-02-28', 3097.13, 6802.87, ''], ['2025-03-30', 2933.8, 6966.2, ''],
    ['2025-04-30', 2726.04, 7173.96, ''], ['2025-05-30', 3019.89, 6880.11, ''], ['2025-06-30', 2007.02, 7892.98, ''],
    ['2025-07-30', 1313.6, 8586.4, ''], ['2025-08-30', 2020.1, 7879.9, ''], ['2025-09-30', 4500.49, 5399.51, ''],
    ['2025-10-30', 4688.54, 5211.46, ''], ['2025-11-30', 4529.75, 5370.25, ''], ['2025-12-30', 4716.95, 5183.05, ''],
    ['2026-01-30', 4559.21, 5340.79, ''], ['2026-02-28', 4917.35, 4982.65, ''], ['2026-03-30', 4760.7, 5139.3, ''],
    ['2026-04-30', 4604.55, 5295.45, ''], ['2026-05-30', 4789.56, 5110.44, ''], ['2026-06-30', 4634.47, 5265.53, ''],
    ['2026-07-30', 4818.61, 5081.39, '']
  ];

  function importHouseLoanSeed() {
    if (!confirm('นำเข้าข้อมูลผ่อนบ้าน ' + houseLoanSeedPayments.length + ' รายการ จากไฟล์ที่แนบไว้ก่อนหน้านี้ใช่หรือไม่')) return;
    Store.add('debts', { name:'ผ่อนบ้าน', principal:1800000, startDate:'2022-06-30', note:'นำเข้าจากไฟล์ผ่อนบ้าน.xlsx' }).then(function(debtId){
      houseLoanSeedPayments.forEach(function(row){
        Store.add('debtPayments', { debtId: debtId, date: row[0], principal: row[1], interest: row[2], note: row[3] });
      });
    });
  }

  function budgetRow(c) {
    var b = Object.values(state.budgets).find(function(x){ return x.categoryId === c.id; });
    return '<div class="settings-row" data-action="edit-budget" data-catid="' + c.id + '">' +
      '<div class="settings-row-title">' + escapeHtml(c.name) + '</div>' +
      '<div class="settings-row-val">' + (b ? fmtMoney(b.amount) : 'ยังไม่ตั้ง') + '</div>' +
    '</div>';
  }

  function recurringRow(r) {
    var cat = state.categories[r.categoryId];
    return '<div class="settings-row" data-action="edit-recurring" data-id="' + r.id + '">' +
      '<div><div class="settings-row-title">' + escapeHtml(r.note||'') + '</div>' +
      '<div class="settings-row-sub">' + (cat?escapeHtml(cat.name):'') + ' · ครั้งถัดไป ' + fmtDateFull(r.nextDate) + '</div></div>' +
      '<div class="settings-row-val ' + (r.type==='income'?'income-text':'expense-text') + '">' + (r.type==='income'?'+':'-') + fmtMoney(r.amount) + '</div>' +
    '</div>';
  }

  function catRow(c) {
    return '<div class="settings-row" data-action="edit-category" data-id="' + c.id + '">' +
      '<div class="settings-row-title">' + escapeHtml(c.name) + '</div>' +
      '<button class="icon-btn danger" data-action="delete-category" data-id="' + c.id + '">✕</button>' +
    '</div>';
  }

  function renderSettings() {
    var accs = Object.values(state.accounts);
    var cats = Object.values(state.categories);
    var incomeCats = cats.filter(function(c){ return c.type==='income'; });
    var expenseCats = cats.filter(function(c){ return c.type==='expense'; });

    var html = '';
    html += '<div class="card-title-row list-header"><div class="card-title">บัญชี/กระเป๋าเงิน</div>' +
      '<button class="link-btn" data-action="add-account">+ เพิ่มบัญชี</button></div>';
    html += '<div class="card list-card">' + (accs.length ? accs.map(function(a){
      return '<div class="settings-row" data-action="edit-account" data-id="' + a.id + '">' +
        '<div><div class="settings-row-title">' + escapeHtml(a.name) + '</div>' +
        '<div class="settings-row-sub">' + (accountTypeLabels[a.type]||'อื่นๆ') + '</div></div>' +
        '<div class="settings-row-val">' + fmtMoney(accountBalance(a.id)) + '</div></div>';
    }).join('') : '<div class="empty-note">ยังไม่มีบัญชี</div>') + '</div>';

    html += '<div class="card-title-row list-header"><div class="card-title">หมวดรายรับ</div>' +
      '<button class="link-btn" data-action="add-category" data-cattype="income">+ เพิ่ม</button></div>';
    html += '<div class="card list-card">' + (incomeCats.length ? incomeCats.map(catRow).join('') : '<div class="empty-note">ยังไม่มีหมวดรายรับ</div>') + '</div>';

    html += '<div class="card-title-row list-header"><div class="card-title">หมวดรายจ่าย</div>' +
      '<button class="link-btn" data-action="add-category" data-cattype="expense">+ เพิ่ม</button></div>';
    html += '<div class="card list-card">' + (expenseCats.length ? expenseCats.map(catRow).join('') : '<div class="empty-note">ยังไม่มีหมวดรายจ่าย</div>') + '</div>';

    html += '<div class="card-title-row list-header"><div class="card-title">งบประมาณรายเดือน</div></div>';
    html += '<div class="card list-card">' + (expenseCats.length ? expenseCats.map(budgetRow).join('') : '<div class="empty-note">เพิ่มหมวดรายจ่ายก่อนเพื่อตั้งงบประมาณ</div>') + '</div>';

    html += '<div class="card-title-row list-header"><div class="card-title">รายการที่เกิดซ้ำทุกเดือน</div>' +
      '<button class="link-btn" data-action="add-recurring">+ เพิ่ม</button></div>';
    var recurringList = Object.values(state.recurringTemplates);
    html += '<div class="card list-card">' + (recurringList.length ? recurringList.map(recurringRow).join('') : '<div class="empty-note">ยังไม่มีรายการที่เกิดซ้ำ เช่น ค่าเช่า ค่าบริการรายเดือน</div>') + '</div>';

    html += '<div class="card-title-row list-header"><div class="card-title">บัญชีผู้ใช้</div></div>';
    html += '<div class="card">' +
      '<div class="settings-row"><div><div class="settings-row-title">เข้าสู่ระบบด้วย</div>' +
      '<div class="settings-row-sub">' + escapeHtml(currentUserEmail) + ' · ซิงค์ทุกอุปกรณ์ที่ล็อกอินบัญชีนี้</div></div></div>' +
      '<button class="secondary-btn full-btn" data-action="export-csv">ส่งออกรายการเป็น CSV</button>' +
      '<button class="secondary-btn full-btn" data-action="sign-out">ออกจากระบบ</button>' +
    '</div>';
    return html;
  }

  // ---------- modals ----------
  function openModal(html) {
    modalContentEl.innerHTML = html;
    modalOverlayEl.classList.add('open');
  }
  function closeModal() {
    modalOverlayEl.classList.remove('open');
    modalContentEl.innerHTML = '';
  }

  function transactionModal(existing) {
    existing = existing || {};
    var isEdit = !!existing.id;
    var type = existing.type || 'expense';
    var cats = Object.values(state.categories).filter(function(c){ return c.type===type; });
    var accs = Object.values(state.accounts);
    return '' +
      '<form id="txForm" class="modal-form">' +
        '<div class="modal-header"><div class="modal-title">' + (isEdit?'แก้ไขรายการ':'เพิ่มรายรับ-รายจ่าย') + '</div>' +
        '<button type="button" class="icon-btn" data-action="close-modal">✕</button></div>' +
        '<div class="type-toggle">' +
          '<button type="button" class="type-btn' + (type==='expense'?' active expense':'') + '" data-action="tx-type" data-type="expense">รายจ่าย</button>' +
          '<button type="button" class="type-btn' + (type==='income'?' active income':'') + '" data-action="tx-type" data-type="income">รายรับ</button>' +
        '</div>' +
        '<input type="hidden" name="type" value="' + type + '">' +
        (isEdit ? '<input type="hidden" name="id" value="' + existing.id + '">' : '') +
        '<label class="field"><span>จำนวนเงิน</span><input type="number" step="0.01" min="0" name="amount" required value="' + (existing.amount!=null?existing.amount:'') + '" placeholder="0.00"></label>' +
        '<label class="field"><span>บัญชี</span><select name="accountId" required>' +
          accs.map(function(a){ return '<option value="' + a.id + '"' + (existing.accountId===a.id?' selected':'') + '>' + escapeHtml(a.name) + '</option>'; }).join('') +
        '</select></label>' +
        '<label class="field"><span>หมวดหมู่</span><select name="categoryId" required>' +
          cats.map(function(c){ return '<option value="' + c.id + '"' + (existing.categoryId===c.id?' selected':'') + '>' + escapeHtml(c.name) + '</option>'; }).join('') +
        '</select></label>' +
        '<label class="field"><span>วันที่</span><input type="date" name="date" required value="' + (existing.date?existing.date.slice(0,10):todayISO()) + '"></label>' +
        '<label class="field"><span>โน้ต (ไม่บังคับ)</span><input type="text" name="note" value="' + escapeHtml(existing.note||'') + '" placeholder="รายละเอียดเพิ่มเติม"></label>' +
        '<div class="modal-actions">' +
          (isEdit ? '<button type="button" class="danger-btn" data-action="delete-tx" data-id="' + existing.id + '">ลบ</button>' : '<span></span>') +
          '<button type="submit" class="primary-btn">บันทึก</button>' +
        '</div>' +
      '</form>';
  }

  function accountModal(existing) {
    existing = existing || null;
    return '' +
      '<form id="accountForm" class="modal-form">' +
        '<div class="modal-header"><div class="modal-title">' + (existing?'แก้ไขบัญชี':'เพิ่มบัญชี') + '</div>' +
        '<button type="button" class="icon-btn" data-action="close-modal">✕</button></div>' +
        (existing ? '<input type="hidden" name="id" value="' + existing.id + '">' : '') +
        '<label class="field"><span>ชื่อบัญชี</span><input type="text" name="name" required value="' + escapeHtml(existing?existing.name:'') + '" placeholder="เช่น บัญชีออมทรัพย์"></label>' +
        '<label class="field"><span>ประเภท</span><select name="type">' +
          Object.keys(accountTypeLabels).map(function(k){ return '<option value="' + k + '"' + (existing&&existing.type===k?' selected':'') + '>' + accountTypeLabels[k] + '</option>'; }).join('') +
        '</select></label>' +
        '<div class="modal-actions">' +
          (existing ? '<button type="button" class="danger-btn" data-action="delete-account" data-id="' + existing.id + '">ลบ</button>' : '<span></span>') +
          '<button type="submit" class="primary-btn">บันทึก</button>' +
        '</div>' +
      '</form>';
  }

  function categoryModal(existing, defaultType) {
    existing = existing || null;
    var type = (existing && existing.type) || defaultType || 'expense';
    return '' +
      '<form id="categoryForm" class="modal-form">' +
        '<div class="modal-header"><div class="modal-title">' + (existing?'แก้ไขหมวดหมู่':'เพิ่มหมวดหมู่') + '</div>' +
        '<button type="button" class="icon-btn" data-action="close-modal">✕</button></div>' +
        (existing ? '<input type="hidden" name="id" value="' + existing.id + '">' : '') +
        '<input type="hidden" name="type" value="' + type + '">' +
        '<label class="field"><span>ชื่อหมวดหมู่ (' + (type==='income'?'รายรับ':'รายจ่าย') + ')</span>' +
        '<input type="text" name="name" required value="' + escapeHtml(existing?existing.name:'') + '" placeholder="เช่น อาหาร"></label>' +
        '<div class="modal-actions"><span></span><button type="submit" class="primary-btn">บันทึก</button></div>' +
      '</form>';
  }

  function holdingModal(existing) {
    existing = existing || null;
    return '' +
      '<form id="holdingForm" class="modal-form">' +
        '<div class="modal-header"><div class="modal-title">' + (existing?'แก้ไขรายการลงทุน':'เพิ่มรายการลงทุน') + '</div>' +
        '<button type="button" class="icon-btn" data-action="close-modal">✕</button></div>' +
        (existing ? '<input type="hidden" name="id" value="' + existing.id + '">' : '') +
        '<label class="field"><span>สัญลักษณ์/ชื่อย่อ</span><input type="text" name="symbol" required value="' + escapeHtml(existing?existing.symbol:'') + '" placeholder="เช่น PTT, SPY, BTC"></label>' +
        '<label class="field"><span>ชื่อเต็ม (ไม่บังคับ)</span><input type="text" name="name" value="' + escapeHtml(existing?existing.name||'':'') + '" placeholder="เช่น บมจ.ปตท."></label>' +
        '<label class="field"><span>ประเภทสินทรัพย์</span><select name="assetType">' +
          Object.keys(assetTypeLabels).map(function(k){ return '<option value="' + k + '"' + (existing&&existing.assetType===k?' selected':'') + '>' + assetTypeLabels[k] + '</option>'; }).join('') +
        '</select></label>' +
        '<label class="field"><span>จำนวนหน่วยที่ถืออยู่</span><input type="number" step="0.0001" min="0" name="quantity" required value="' + (existing?existing.quantity:'') + '" placeholder="0"></label>' +
        '<label class="field"><span>ต้นทุนเฉลี่ยต่อหน่วย</span><input type="number" step="0.01" min="0" name="avgCost" required value="' + (existing?existing.avgCost:'') + '" placeholder="0.00"></label>' +
        '<label class="field"><span>ราคาตลาดล่าสุดต่อหน่วย</span><input type="number" step="0.01" min="0" name="currentPrice" required value="' + (existing?existing.currentPrice:'') + '" placeholder="0.00"></label>' +
        '<div class="modal-actions">' +
          (existing ? '<button type="button" class="danger-btn" data-action="delete-holding" data-id="' + existing.id + '">ลบ</button>' : '<span></span>') +
          '<button type="submit" class="primary-btn">บันทึก</button>' +
        '</div>' +
      '</form>';
  }

  function updatePriceModal(h) {
    return '' +
      '<form id="priceForm" class="modal-form">' +
        '<div class="modal-header"><div class="modal-title">อัปเดตราคา · ' + escapeHtml(h.symbol) + '</div>' +
        '<button type="button" class="icon-btn" data-action="close-modal">✕</button></div>' +
        '<input type="hidden" name="id" value="' + h.id + '">' +
        '<label class="field"><span>ราคาตลาดล่าสุดต่อหน่วย</span><input type="number" step="0.01" min="0" name="currentPrice" required value="' + h.currentPrice + '"></label>' +
        '<div class="modal-actions"><span></span><button type="submit" class="primary-btn">บันทึก</button></div>' +
      '</form>';
  }

  function investTxFields(type) {
    if (type === 'dividend') {
      return '<label class="field"><span>จำนวนเงินปันผลที่ได้รับ</span><input type="number" step="0.01" min="0" name="amount" required placeholder="0.00"></label>';
    }
    return '' +
      '<label class="field"><span>จำนวนหน่วย</span><input type="number" step="0.0001" min="0" name="quantity" required placeholder="0"></label>' +
      '<label class="field"><span>ราคาต่อหน่วย</span><input type="number" step="0.01" min="0" name="price" required placeholder="0.00"></label>' +
      '<label class="field"><span>ค่าธรรมเนียม (ไม่บังคับ)</span><input type="number" step="0.01" min="0" name="fee" placeholder="0.00"></label>';
  }

  function investTxModal(h) {
    return '' +
      '<form id="investTxForm" class="modal-form">' +
        '<div class="modal-header"><div class="modal-title">บันทึกธุรกรรม · ' + escapeHtml(h.symbol) + '</div>' +
        '<button type="button" class="icon-btn" data-action="close-modal">✕</button></div>' +
        '<input type="hidden" name="holdingId" value="' + h.id + '">' +
        '<input type="hidden" name="type" value="buy">' +
        '<div class="type-toggle">' +
          '<button type="button" class="type-btn active" data-action="invtx-type" data-type="buy">ซื้อ</button>' +
          '<button type="button" class="type-btn" data-action="invtx-type" data-type="sell">ขาย</button>' +
          '<button type="button" class="type-btn" data-action="invtx-type" data-type="dividend">ปันผล</button>' +
        '</div>' +
        '<div id="investTxFields">' + investTxFields('buy') + '</div>' +
        '<label class="field"><span>วันที่</span><input type="date" name="date" required value="' + todayISO() + '"></label>' +
        '<label class="field"><span>โน้ต (ไม่บังคับ)</span><input type="text" name="note" placeholder="รายละเอียดเพิ่มเติม"></label>' +
        '<div class="modal-actions"><span></span><button type="submit" class="primary-btn">บันทึก</button></div>' +
      '</form>';
  }

  function debtModal(existing) {
    existing = existing || null;
    return '' +
      '<form id="debtForm" class="modal-form">' +
        '<div class="modal-header"><div class="modal-title">' + (existing?'แก้ไขหนี้':'เพิ่มหนี้ใหม่') + '</div>' +
        '<button type="button" class="icon-btn" data-action="close-modal">✕</button></div>' +
        (existing ? '<input type="hidden" name="id" value="' + existing.id + '">' : '') +
        '<label class="field"><span>ชื่อรายการหนี้</span><input type="text" name="name" required value="' + escapeHtml(existing?existing.name:'') + '" placeholder="เช่น ผ่อนบ้าน, สินเชื่อรถ"></label>' +
        '<label class="field"><span>ยอดกู้ตั้งต้น</span><input type="number" step="0.01" min="0" name="principal" required value="' + (existing?existing.principal:'') + '" placeholder="0.00"></label>' +
        '<label class="field"><span>วันที่เริ่มกู้ (ไม่บังคับ)</span><input type="date" name="startDate" value="' + (existing&&existing.startDate?existing.startDate.slice(0,10):'') + '"></label>' +
        '<label class="field"><span>โน้ต (ไม่บังคับ)</span><input type="text" name="note" value="' + escapeHtml(existing?existing.note||'':'') + '" placeholder="เช่น ชื่อธนาคาร"></label>' +
        '<div class="modal-actions">' +
          (existing ? '<button type="button" class="danger-btn" data-action="delete-debt" data-id="' + existing.id + '">ลบ</button>' : '<span></span>') +
          '<button type="submit" class="primary-btn">บันทึก</button>' +
        '</div>' +
      '</form>';
  }

  function paymentModal(existing, debtId) {
    existing = existing || null;
    return '' +
      '<form id="paymentForm" class="modal-form">' +
        '<div class="modal-header"><div class="modal-title">' + (existing?'แก้ไขรายการผ่อนชำระ':'บันทึกการผ่อนชำระ') + '</div>' +
        '<button type="button" class="icon-btn" data-action="close-modal">✕</button></div>' +
        '<input type="hidden" name="debtId" value="' + (existing?existing.debtId:debtId) + '">' +
        (existing ? '<input type="hidden" name="id" value="' + existing.id + '">' : '') +
        '<label class="field"><span>วันที่ชำระ</span><input type="date" name="date" required value="' + (existing?existing.date.slice(0,10):todayISO()) + '"></label>' +
        '<label class="field"><span>เงินต้น</span><input type="number" step="0.01" min="0" name="principal" required value="' + (existing?existing.principal:'') + '" placeholder="0.00"></label>' +
        '<label class="field"><span>ดอกเบี้ย</span><input type="number" step="0.01" min="0" name="interest" required value="' + (existing?existing.interest:'') + '" placeholder="0.00"></label>' +
        '<label class="field"><span>โน้ต (ไม่บังคับ)</span><input type="text" name="note" value="' + escapeHtml(existing?existing.note||'':'') + '"></label>' +
        '<div class="modal-actions">' +
          (existing ? '<button type="button" class="danger-btn" data-action="delete-payment" data-id="' + existing.id + '">ลบ</button>' : '<span></span>') +
          '<button type="submit" class="primary-btn">บันทึก</button>' +
        '</div>' +
      '</form>';
  }

  function budgetModal(category) {
    var existing = Object.values(state.budgets).find(function(x){ return x.categoryId === category.id; });
    return '' +
      '<form id="budgetForm" class="modal-form">' +
        '<div class="modal-header"><div class="modal-title">งบประมาณ · ' + escapeHtml(category.name) + '</div>' +
        '<button type="button" class="icon-btn" data-action="close-modal">✕</button></div>' +
        '<input type="hidden" name="categoryId" value="' + category.id + '">' +
        (existing ? '<input type="hidden" name="id" value="' + existing.id + '">' : '') +
        '<label class="field"><span>วงเงินต่อเดือน</span><input type="number" step="0.01" min="0" name="amount" required value="' + (existing?existing.amount:'') + '" placeholder="0.00"></label>' +
        '<div class="modal-actions">' +
          (existing ? '<button type="button" class="danger-btn" data-action="delete-budget" data-id="' + existing.id + '">ลบงบ</button>' : '<span></span>') +
          '<button type="submit" class="primary-btn">บันทึก</button>' +
        '</div>' +
      '</form>';
  }

  function recurringModal(existing) {
    existing = existing || {};
    var type = existing.type || 'expense';
    var cats = Object.values(state.categories).filter(function(c){ return c.type === type; });
    var accs = Object.values(state.accounts);
    return '' +
      '<form id="recurringForm" class="modal-form">' +
        '<div class="modal-header"><div class="modal-title">' + (existing.id?'แก้ไขรายการที่เกิดซ้ำ':'เพิ่มรายการที่เกิดซ้ำ') + '</div>' +
        '<button type="button" class="icon-btn" data-action="close-modal">✕</button></div>' +
        '<div class="type-toggle">' +
          '<button type="button" class="type-btn' + (type==='expense'?' active expense':'') + '" data-action="rec-type" data-type="expense">รายจ่าย</button>' +
          '<button type="button" class="type-btn' + (type==='income'?' active income':'') + '" data-action="rec-type" data-type="income">รายรับ</button>' +
        '</div>' +
        '<input type="hidden" name="type" value="' + type + '">' +
        (existing.id ? '<input type="hidden" name="id" value="' + existing.id + '">' : '') +
        '<label class="field"><span>ชื่อรายการ</span><input type="text" name="note" required value="' + escapeHtml(existing.note||'') + '" placeholder="เช่น ค่าเช่าบ้าน, Netflix"></label>' +
        '<label class="field"><span>จำนวนเงิน</span><input type="number" step="0.01" min="0" name="amount" required value="' + (existing.amount!=null?existing.amount:'') + '" placeholder="0.00"></label>' +
        '<label class="field"><span>บัญชี</span><select name="accountId" required>' +
          accs.map(function(a){ return '<option value="' + a.id + '"' + (existing.accountId===a.id?' selected':'') + '>' + escapeHtml(a.name) + '</option>'; }).join('') +
        '</select></label>' +
        '<label class="field"><span>หมวดหมู่</span><select name="categoryId" required>' +
          cats.map(function(c){ return '<option value="' + c.id + '"' + (existing.categoryId===c.id?' selected':'') + '>' + escapeHtml(c.name) + '</option>'; }).join('') +
        '</select></label>' +
        '<label class="field"><span>วันที่ครั้งถัดไป</span><input type="date" name="nextDate" required value="' + (existing.nextDate?existing.nextDate.slice(0,10):todayISO()) + '"></label>' +
        '<div class="modal-actions">' +
          (existing.id ? '<button type="button" class="danger-btn" data-action="delete-recurring" data-id="' + existing.id + '">ลบ</button>' : '<span></span>') +
          '<button type="submit" class="primary-btn">บันทึก</button>' +
        '</div>' +
      '</form>';
  }

  // ---------- form handlers ----------
  function saveTransaction(fd) {
    var data = { type: fd.type, amount: Number(fd.amount), accountId: fd.accountId, categoryId: fd.categoryId, date: fd.date, note: fd.note || '' };
    return fd.id ? Store.update('transactions', fd.id, data) : Store.add('transactions', data);
  }
  function saveAccount(fd) {
    var data = { name: fd.name, type: fd.type };
    return fd.id ? Store.update('accounts', fd.id, data) : Store.add('accounts', data);
  }
  function saveCategory(fd) {
    var data = { name: fd.name, type: fd.type };
    return fd.id ? Store.update('categories', fd.id, data) : Store.add('categories', data);
  }
  function saveHolding(fd) {
    var data = { symbol: fd.symbol, name: fd.name || '', assetType: fd.assetType, quantity: Number(fd.quantity), avgCost: Number(fd.avgCost), currentPrice: Number(fd.currentPrice) };
    return fd.id ? Store.update('holdings', fd.id, data) : Store.add('holdings', data);
  }
  function savePrice(fd) {
    return Store.update('holdings', fd.id, { currentPrice: Number(fd.currentPrice) });
  }
  function saveInvestTx(fd) {
    var holding = state.holdings[fd.holdingId];
    if (!holding) return Promise.reject(new Error('ไม่พบรายการลงทุนนี้'));
    var type = fd.type;
    var record = { holdingId: fd.holdingId, type: type, date: fd.date, note: fd.note || '' };
    var updateP = Promise.resolve();

    if (type === 'dividend') {
      record.amount = Number(fd.amount);
    } else {
      var qty = Number(fd.quantity);
      var price = Number(fd.price);
      var fee = Number(fd.fee || 0);
      record.quantity = qty; record.price = price; record.fee = fee;
      record.amount = qty*price + (type==='buy'?fee:-fee);
      var curQty = Number(holding.quantity) || 0;
      var curAvg = Number(holding.avgCost) || 0;
      if (type === 'buy') {
        var newQty = curQty + qty;
        var newAvg = newQty > 0 ? (curQty*curAvg + qty*price + fee) / newQty : 0;
        updateP = Store.update('holdings', holding.id, { quantity: newQty, avgCost: newAvg });
      } else if (type === 'sell') {
        if (qty > curQty) return Promise.reject(new Error('จำนวนที่ขายมากกว่าที่ถืออยู่'));
        updateP = Store.update('holdings', holding.id, { quantity: curQty - qty });
      }
    }
    return updateP.then(function(){ return Store.add('investmentTxns', record); });
  }

  function confirmDeleteTx(id) {
    if (confirm('ลบรายการนี้ใช่หรือไม่')) { Store.remove('transactions', id); closeModal(); }
  }
  function confirmDeleteAccount(id) {
    var hasTx = Object.values(state.transactions).some(function(t){ return t.accountId===id; });
    if (hasTx) { alert('ไม่สามารถลบบัญชีที่มีรายการอยู่ได้ กรุณาลบหรือย้ายรายการก่อน'); return; }
    if (confirm('ลบบัญชีนี้ใช่หรือไม่')) { Store.remove('accounts', id); closeModal(); }
  }
  function confirmDeleteCategory(id) {
    var hasTx = Object.values(state.transactions).some(function(t){ return t.categoryId===id; });
    if (hasTx) { alert('ไม่สามารถลบหมวดหมู่ที่มีรายการอยู่ได้'); return; }
    if (confirm('ลบหมวดหมู่นี้ใช่หรือไม่')) { Store.remove('categories', id); }
  }
  function confirmDeleteHolding(id) {
    if (confirm('ลบรายการลงทุนนี้ใช่หรือไม่ (ประวัติธุรกรรมจะยังคงอยู่)')) { Store.remove('holdings', id); closeModal(); }
  }

  function saveDebt(fd) {
    var data = { name: fd.name, principal: Number(fd.principal), startDate: fd.startDate || '', note: fd.note || '' };
    return fd.id ? Store.update('debts', fd.id, data) : Store.add('debts', data);
  }
  function savePayment(fd) {
    var data = { debtId: fd.debtId, date: fd.date, principal: Number(fd.principal), interest: Number(fd.interest), note: fd.note || '' };
    return fd.id ? Store.update('debtPayments', fd.id, data) : Store.add('debtPayments', data);
  }
  function confirmDeleteDebt(id) {
    if (paymentsForDebt(id).length > 0) { alert('ไม่สามารถลบหนี้ที่มีประวัติการผ่อนชำระอยู่ได้ กรุณาลบรายการผ่อนชำระก่อน'); return; }
    if (confirm('ลบรายการหนี้นี้ใช่หรือไม่')) { Store.remove('debts', id); closeModal(); selectedDebtId = null; }
  }
  function confirmDeletePayment(id) {
    if (confirm('ลบรายการนี้ใช่หรือไม่')) { Store.remove('debtPayments', id); closeModal(); }
  }

  function saveBudget(fd) {
    var data = { categoryId: fd.categoryId, amount: Number(fd.amount) };
    return fd.id ? Store.update('budgets', fd.id, data) : Store.add('budgets', data);
  }
  function confirmDeleteBudget(id) {
    if (confirm('ลบงบประมาณนี้ใช่หรือไม่')) { Store.remove('budgets', id); closeModal(); }
  }

  function saveRecurring(fd) {
    var data = { type: fd.type, note: fd.note, amount: Number(fd.amount), accountId: fd.accountId, categoryId: fd.categoryId, nextDate: fd.nextDate, dayOfMonth: new Date(fd.nextDate).getDate(), active: true };
    return fd.id ? Store.update('recurringTemplates', fd.id, data) : Store.add('recurringTemplates', data);
  }
  function confirmDeleteRecurring(id) {
    if (confirm('ลบรายการที่เกิดซ้ำนี้ใช่หรือไม่')) { Store.remove('recurringTemplates', id); closeModal(); }
  }
  function handleRecTypeSwitch(newType) {
    var form = document.getElementById('recurringForm');
    var fd = Object.fromEntries(new FormData(form).entries());
    openModal(recurringModal({ id: fd.id, type: newType, note: fd.note, amount: fd.amount, accountId: fd.accountId, nextDate: fd.nextDate }));
  }

  function handleTxTypeSwitch(newType) {
    var form = document.getElementById('txForm');
    var fd = Object.fromEntries(new FormData(form).entries());
    openModal(transactionModal({ id: fd.id, type: newType, amount: fd.amount, accountId: fd.accountId, date: fd.date, note: fd.note }));
  }
  function handleInvTxTypeSwitch(newType) {
    var form = document.getElementById('investTxForm');
    form.querySelectorAll('.type-btn').forEach(function(b){ b.classList.toggle('active', b.dataset.type===newType); });
    form.querySelector('input[name="type"]').value = newType;
    document.getElementById('investTxFields').innerHTML = investTxFields(newType);
  }

  function handleFabAdd() {
    if (!allReady()) return;
    if (currentTab === 'investments') { openModal(holdingModal(null)); return; }
    if (currentTab === 'debts') {
      if (selectedDebtId) openModal(paymentModal(null, selectedDebtId));
      else openModal(debtModal(null));
      return;
    }
    if (Object.keys(state.accounts).length === 0 || Object.keys(state.categories).length === 0) {
      alert('กำลังเตรียมข้อมูลเริ่มต้น กรุณาลองใหม่อีกครั้งในไม่กี่วินาที');
      return;
    }
    openModal(transactionModal(null));
  }

  function exportCsv() {
    var rows = [['วันที่','ประเภท','บัญชี','หมวดหมู่','จำนวนเงิน','โน้ต']];
    Object.values(state.transactions).sort(function(a,b){ return (a.date||'').localeCompare(b.date||''); }).forEach(function(t){
      rows.push([ t.date, t.type==='income'?'รายรับ':'รายจ่าย',
        (state.accounts[t.accountId]&&state.accounts[t.accountId].name)||'',
        (state.categories[t.categoryId]&&state.categories[t.categoryId].name)||'',
        t.amount, t.note||'' ]);
    });
    var csv = rows.map(function(r){ return r.map(csvEscape).join(','); }).join('\r\n');
    var blob = new Blob(["\uFEFF" + csv], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = 'transactions.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ---------- event delegation ----------
  document.addEventListener('click', function(e){
    var el = e.target.closest('[data-action]');
    if (!el) return;
    var action = el.dataset.action;
    var id = el.dataset.id;
    switch (action) {
      case 'go-tab': switchTab(el.dataset.tab); break;
      case 'close-modal': closeModal(); break;
      case 'month-prev': shiftMonth(-1); renderTab(); break;
      case 'month-next': shiftMonth(1); renderTab(); break;
      case 'add-account': openModal(accountModal(null)); break;
      case 'edit-account': openModal(accountModal(state.accounts[id])); break;
      case 'delete-account': confirmDeleteAccount(id); break;
      case 'add-category': openModal(categoryModal(null, el.dataset.cattype)); break;
      case 'edit-category': openModal(categoryModal(state.categories[id])); break;
      case 'delete-category': confirmDeleteCategory(id); break;
      case 'edit-tx': openModal(transactionModal(state.transactions[id])); break;
      case 'delete-tx': confirmDeleteTx(id); break;
      case 'tx-type': handleTxTypeSwitch(el.dataset.type); break;
      case 'add-holding': openModal(holdingModal(null)); break;
      case 'edit-holding': openModal(holdingModal(state.holdings[id])); break;
      case 'delete-holding': confirmDeleteHolding(id); break;
      case 'update-price': openModal(updatePriceModal(state.holdings[id])); break;
      case 'record-invest-tx': openModal(investTxModal(state.holdings[id])); break;
      case 'invtx-type': handleInvTxTypeSwitch(el.dataset.type); break;
      case 'export-csv': exportCsv(); break;
      case 'sign-out': confirmSignOut(); break;
      case 'auth-tab': showAuthTab(el.dataset.authtab); break;
      case 'select-trend-month': selectedTrendMonth = el.dataset.month; renderTab(); break;
      case 'add-debt': openModal(debtModal(null)); break;
      case 'edit-debt': openModal(debtModal(state.debts[id])); break;
      case 'delete-debt': confirmDeleteDebt(id); break;
      case 'view-debt': selectedDebtId = id; renderTab(); break;
      case 'back-to-debts': selectedDebtId = null; renderTab(); break;
      case 'add-payment': openModal(paymentModal(null, id)); break;
      case 'edit-payment': openModal(paymentModal(state.debtPayments[id])); break;
      case 'delete-payment': confirmDeletePayment(id); break;
      case 'import-house-loan': importHouseLoanSeed(); break;
      case 'edit-budget': openModal(budgetModal(state.categories[el.dataset.catid])); break;
      case 'delete-budget': confirmDeleteBudget(id); break;
      case 'add-recurring': openModal(recurringModal(null)); break;
      case 'edit-recurring': openModal(recurringModal(state.recurringTemplates[id])); break;
      case 'delete-recurring': confirmDeleteRecurring(id); break;
      case 'rec-type': handleRecTypeSwitch(el.dataset.type); break;
    }
  });

  document.getElementById('fabBtn').addEventListener('click', handleFabAdd);

  document.addEventListener('change', function(e){
    var el = e.target;
    if (!el.dataset) return;
    if (el.dataset.action === 'filter-type') { txFilter.type = el.value; renderTab(); }
    if (el.dataset.action === 'filter-account') { txFilter.accountId = el.value; renderTab(); }
  });

  document.addEventListener('submit', function(e){
    e.preventDefault();
    var form = e.target;
    var fd = Object.fromEntries(new FormData(form).entries());
    var action;
    if (form.id === 'txForm') action = saveTransaction(fd);
    else if (form.id === 'accountForm') action = saveAccount(fd);
    else if (form.id === 'categoryForm') action = saveCategory(fd);
    else if (form.id === 'holdingForm') action = saveHolding(fd);
    else if (form.id === 'priceForm') action = savePrice(fd);
    else if (form.id === 'investTxForm') action = saveInvestTx(fd);
    else if (form.id === 'debtForm') action = saveDebt(fd);
    else if (form.id === 'paymentForm') action = savePayment(fd);
    else if (form.id === 'budgetForm') action = saveBudget(fd);
    else if (form.id === 'recurringForm') action = saveRecurring(fd);
    else return;
    Promise.resolve(action).then(closeModal).catch(function(err){
      alert('เกิดข้อผิดพลาด: ' + (err && err.message ? err.message : err));
    });
  });

  modalOverlayEl.addEventListener('click', function(e){
    if (e.target === modalOverlayEl) closeModal();
  });

  // ---------- auth screens ----------
  var loadingScreenEl = document.getElementById('loadingScreen');
  var authScreenEl = document.getElementById('authScreen');
  var appShellEl = document.getElementById('appShell');
  var authMessageEl = document.getElementById('authMessage');

  function showApp() {
    loadingScreenEl.style.display = 'none';
    authScreenEl.style.display = 'none';
    appShellEl.style.display = '';
  }
  function showAuth() {
    loadingScreenEl.style.display = 'none';
    appShellEl.style.display = 'none';
    authScreenEl.style.display = 'flex';
  }
  function setAuthMessage(msg, ok) {
    authMessageEl.textContent = msg;
    authMessageEl.className = 'auth-message' + (ok ? ' success' : '');
  }
  function showAuthTab(tab) {
    ['login','signup','reset'].forEach(function(t){
      document.getElementById(t + 'Form').style.display = (t === tab) ? 'flex' : 'none';
    });
    document.querySelectorAll('#authTabs .type-btn').forEach(function(b){
      b.classList.toggle('active', b.dataset.authtab === tab);
    });
    setAuthMessage('', false);
  }
  function translateAuthError(err) {
    var msg = (err && err.message) || '';
    if (/Invalid login credentials/i.test(msg)) return 'อีเมลหรือรหัสผ่านไม่ถูกต้อง';
    if (/already registered/i.test(msg)) return 'อีเมลนี้สมัครไว้แล้ว ลองเข้าสู่ระบบแทน';
    if (/Password should be at least/i.test(msg)) return 'รหัสผ่านสั้นเกินไป ต้องมีอย่างน้อย 6 ตัวอักษร';
    return msg || 'เกิดข้อผิดพลาด กรุณาลองใหม่';
  }
  function confirmSignOut() {
    if (confirm('ออกจากระบบใช่หรือไม่')) supabaseClient.auth.signOut();
  }

  document.getElementById('loginForm').addEventListener('submit', function(e){
    e.preventDefault();
    var fd = Object.fromEntries(new FormData(e.target).entries());
    setAuthMessage('', false);
    supabaseClient.auth.signInWithPassword({ email: fd.email, password: fd.password }).then(function(res){
      if (res.error) setAuthMessage(translateAuthError(res.error), false);
    });
  });
  document.getElementById('signupForm').addEventListener('submit', function(e){
    e.preventDefault();
    var fd = Object.fromEntries(new FormData(e.target).entries());
    setAuthMessage('', false);
    supabaseClient.auth.signUp({ email: fd.email, password: fd.password }).then(function(res){
      if (res.error) { setAuthMessage(translateAuthError(res.error), false); return; }
      if (!(res.data && res.data.session)) setAuthMessage('สมัครสำเร็จ กรุณายืนยันอีเมลก่อนเข้าสู่ระบบ', true);
    });
  });
  document.getElementById('resetForm').addEventListener('submit', function(e){
    e.preventDefault();
    var fd = Object.fromEntries(new FormData(e.target).entries());
    supabaseClient.auth.resetPasswordForEmail(fd.email).then(function(res){
      if (res.error) setAuthMessage(translateAuthError(res.error), false);
      else setAuthMessage('ส่งลิงก์ไปที่อีเมลแล้ว กรุณาตรวจสอบกล่องจดหมาย', true);
    });
  });

  // ---------- init ----------
  supabaseClient.auth.onAuthStateChange(function(event, session) {
    if (session && session.user) {
      currentUserId = session.user.id;
      currentUserEmail = session.user.email || '';
      updateSyncStatus();
      showApp();
      loadUserData(currentUserId);
      subscribeRealtime(currentUserId);
    } else {
      currentUserId = null;
      currentUserEmail = '';
      showAuth();
    }
  });
})();
