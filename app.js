(function(){
  "use strict";

  // ===================================================================
  // ตั้งค่า Supabase ของคุณตรงนี้ (หาได้ที่ Project Settings > API ใน Supabase)
  // ===================================================================
  var SUPABASE_URL = 'https://xwklhkggusvholfdnnbk.supabase.co';
  var SUPABASE_ANON_KEY = 'sb_publishable_faMlHF7cD_CNCxCyQ8j7bA_QZv2eS3B';
  // ===================================================================

  var accountTypeLabels = { cash:'เงินสด', bank:'บัญชีธนาคาร', credit:'บัตรเครดิต', ewallet:'อีวอลเล็ท', other:'อื่นๆ' };
  var assetTypeLabels = { stock:'หุ้น/กองทุน', crypto:'คริปโต', gold:'ทองคำ', bond:'พันธบัตร' };
  // กลุ่มที่ใช้แสดงผลในหน้า "ลงทุน" — รวมทองคำ+พันธบัตรไว้กลุ่มเดียวกันตามที่ตกลงกันตอนออกแบบ
  var assetGroups = [
    { key:'stock', label:'หุ้น/กองทุน', types:['stock'] },
    { key:'crypto', label:'คริปโต', types:['crypto'] },
    { key:'goldbond', label:'ทองคำ/พันธบัตร', types:['gold','bond'] }
  ];
  var PRICE_STALE_DAYS = 30; // ราคาที่ไม่อัปเดตเกินกี่วันถือว่า "เก่า" (ผู้ใช้ DCA เป็นหลัก ไม่เช็คราคาถี่)
  var defaultAccounts = [ {name:'เงินสด', type:'cash'}, {name:'บัญชีธนาคาร', type:'bank'} ];
  var defaultCategories = [
    {name:'เงินเดือน', type:'income'}, {name:'รายได้เสริม', type:'income'},
    {name:'อาหาร', type:'expense'}, {name:'เดินทาง', type:'expense'},
    {name:'ที่พัก/บิล', type:'expense'}, {name:'ช้อปปิ้ง', type:'expense'},
    {name:'สุขภาพ', type:'expense'}, {name:'บันเทิง', type:'expense'}, {name:'อื่นๆ', type:'expense'}
  ];

  var state = { accounts:{}, categories:{}, transactions:{}, holdings:{}, investmentTxns:{}, debts:{}, debtPayments:{}, budgets:{}, recurringTemplates:{}, meta:{},
    ready: { accounts:false, categories:false, transactions:false, holdings:false, investmentTxns:false, debts:false, debtPayments:false, budgets:false, recurringTemplates:false, meta:false } };
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
  var sideFabBtnEl = document.getElementById('sideFabBtn');
  var toastContainerEl = document.getElementById('toastContainer');

  function showToast(message, type) {
    if (!toastContainerEl) return;
    var el = document.createElement('div');
    el.className = 'toast ' + (type === 'error' ? 'toast-error' : 'toast-success');
    el.textContent = message;
    toastContainerEl.appendChild(el);
    requestAnimationFrame(function(){ el.classList.add('show'); });
    setTimeout(function(){
      el.classList.remove('show');
      setTimeout(function(){ el.remove(); }, 250);
    }, 2800);
  }

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
  // สำหรับตัวเลขเกี่ยวกับการลงทุน (ราคาต่อหน่วย/มูลค่ารวม) — คริปโตหรือสินทรัพย์บางอย่างมีราคาทศนิยมเยอะ
  // ถ้าบังคับ 2 ตำแหน่งแบบ fmtMoney() จะปัดจนข้อมูลหาย เลยให้แสดงได้สูงสุด 8 ตำแหน่ง (ตัดศูนย์ท้ายออก, ขั้นต่ำยังคง 2 ตำแหน่งเหมือนเดิม)
  function fmtInvMoney(n) {
    n = Number(n) || 0;
    var sign = n < 0 ? '-' : '';
    return sign + '฿' + Math.abs(n).toLocaleString('th-TH', {minimumFractionDigits:2, maximumFractionDigits:8});
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
  // ตรวจว่าเป็นตัวเลขที่ไม่ติดลบ ก่อนบันทึกลง state — กันไม่ให้ค่าติดลบ/ค่าที่ไม่ใช่ตัวเลขหลุดเข้าไปคำนวณยอดเงิน
  function requirePositive(v, label) {
    var n = Number(v);
    if (!isFinite(n) || n < 0) throw new Error((label || 'จำนวนเงิน') + 'ต้องเป็นตัวเลขที่ไม่ติดลบ');
    return n;
  }

  // ---------- derived values ----------
  function accountBalance(accId) {
    var bal = 0;
    Object.values(state.transactions).forEach(function(t){
      if (t.type === 'transfer') {
        if (t.fromAccountId === accId) bal -= Number(t.amount);
        if (t.toAccountId === accId) bal += Number(t.amount);
        return;
      }
      if (t.type === 'investment') {
        if (t.accountId !== accId) return;
        // ซื้อ = หักเงินออกจากบัญชี, ขาย/ปันผล = เพิ่มเงินเข้าบัญชี
        bal += t.investAction === 'buy' ? -Number(t.amount) : Number(t.amount);
        return;
      }
      if (t.accountId !== accId) return;
      bal += t.type === 'income' ? Number(t.amount) : -Number(t.amount);
    });
    return bal;
  }
  // บัญชีที่เป็นบัตรเครดิต: ยอดติดลบ = หนี้ที่ค้างอยู่ (คำนวณสดจาก transactions ไม่มีข้อมูลซ้ำ)
  function creditAccounts() {
    return Object.values(state.accounts).filter(function(a){ return a.type === 'credit'; });
  }
  function creditDebtRemaining(acc) {
    return Math.max(0, -accountBalance(acc.id));
  }
  function totalCreditDebtRemaining() {
    return creditAccounts().reduce(function(s,a){ return s + creditDebtRemaining(a); }, 0);
  }
  function lastTxDateForAccount(accId) {
    var latest = null;
    Object.values(state.transactions).forEach(function(t){
      var involved = t.type === 'transfer' ? (t.fromAccountId === accId || t.toAccountId === accId) : t.accountId === accId;
      if (!involved) return;
      if (!latest || (t.date || '') > latest) latest = t.date;
    });
    return latest;
  }
  function fmtRelativeDate(iso) {
    if (!iso) return 'ยังไม่มีรายการ';
    var today = todayISO();
    if (iso === today) return 'วันนี้';
    var diffDays = Math.round((new Date(today) - new Date(iso)) / 86400000);
    if (diffDays === 1) return 'เมื่อวาน';
    if (diffDays > 1 && diffDays < 30) return diffDays + ' วันก่อน';
    return fmtDateShort(iso);
  }
  function totalCash() {
    return Object.keys(state.accounts).reduce(function(sum,id){ return sum + accountBalance(id); }, 0);
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

  // ---------- การลงทุน: derive จากประวัติธุรกรรมสดทุกครั้ง (ไม่ cache) ----------
  function investTxnsForHolding(holdingId) {
    return Object.values(state.investmentTxns).filter(function(t){ return t.holdingId === holdingId; });
  }
  // คำนวณจำนวนหน่วยที่ถืออยู่ + ต้นทุนเฉลี่ยต่อหน่วยสด จากประวัติธุรกรรมทั้งหมดทุกครั้งที่เรียก —
  // เหมือนวิธีที่ทั้งแอปใช้อยู่แล้ว (balance บัญชี, ยอดหนี้คงเหลือ ฯลฯ) กันปัญหาค่า cache ไม่ตรงกับข้อมูลจริง
  function holdingComputed(holdingId) {
    var txns = investTxnsForHolding(holdingId).slice().sort(function(a,b){
      return (a.date||'').localeCompare(b.date||'') || String(a.id).localeCompare(String(b.id));
    });
    var qty = 0, avgCost = 0;
    txns.forEach(function(t){
      if (t.action === 'buy') {
        var txQty = Number(t.qty) || 0;
        var costBefore = qty * avgCost;
        var addCost = txQty * Number(t.pricePerUnit || 0) + Number(t.fee || 0);
        var newQty = qty + txQty;
        avgCost = newQty > 0 ? (costBefore + addCost) / newQty : 0;
        qty = newQty;
      } else if (t.action === 'sell') {
        qty = Math.max(0, qty - (Number(t.qty) || 0));
        // ต้นทุนเฉลี่ยไม่เปลี่ยนตอนขาย (weighted average cost method)
      }
      // dividend ไม่กระทบทั้งจำนวนหน่วยและต้นทุนเฉลี่ย
    });
    return { qty: qty, avgCost: avgCost };
  }
  // ราคาที่ใช้คำนวณมูลค่า: ใช้ราคาล่าสุดที่กรอกเอง ถ้ายังไม่เคยอัปเดตราคาเลยให้ fallback ไปใช้ต้นทุนเฉลี่ยชั่วคราว
  function holdingPrice(h) {
    var c = holdingComputed(h.id);
    return h.lastPrice != null ? Number(h.lastPrice) : c.avgCost;
  }
  function totalInvestmentValue() {
    return Object.values(state.holdings).reduce(function(s, h){
      var c = holdingComputed(h.id);
      return s + c.qty * holdingPrice(h);
    }, 0);
  }
  function totalInvestmentCostAll() {
    return Object.values(state.holdings).reduce(function(s, h){
      var c = holdingComputed(h.id);
      return s + c.qty * c.avgCost;
    }, 0);
  }
  // ราคาล่าสุดถือว่า "เก่า" ถ้าไม่เคยอัปเดตเลย หรืออัปเดตมาเกิน PRICE_STALE_DAYS วันแล้ว
  function isPriceStale(h) {
    if (!h.lastPriceDate) return true;
    var diffDays = Math.round((new Date(todayISO()) - new Date(h.lastPriceDate)) / 86400000);
    return diffDays >= PRICE_STALE_DAYS;
  }

  // ---------- Supabase-backed store (single JSON document per signed-in user) ----------
  var supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  var currentUserId = null;
  var currentUserEmail = '';
  var realtimeChannel = null;
  var saveTimer = null;
  var pendingSaveCount = 0; // นับจำนวนคำขอบันทึกที่ยังส่งไม่เสร็จ (รวมช่วงเน็ตหลุด/กำลัง retry ด้วย)

  var Store = {
    collections: ['accounts','categories','transactions','holdings','investmentTxns','debts','debtPayments','budgets','recurringTemplates','meta'],
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
    saveTimer = null;
    if (!currentUserId) return;
    // ก๊อปปี้ state ปัจจุบัน ณ ตอนนี้ (deep clone) ไม่ใช้ reference ตรงๆ —
    // กันไม่ให้ข้อมูลที่ "กำลังจะส่ง" ถูกแก้ไขกลางทางระหว่างรอเน็ตส่งจริง (เช่น เน็ตหลุดแล้วมา retry ทีหลัง)
    // ซึ่งจะทำให้ยอดที่ส่งไปสับสนกับข้อมูลที่ผู้ใช้แก้ไขเพิ่มเติมหลังจากนั้น
    var payload = {};
    Store.collections.forEach(function(name){ payload[name] = JSON.parse(JSON.stringify(state[name])); });
    // นับว่ามีการบันทึกค้างอยู่ ณ ตอนนี้ (ตั้งแต่เริ่มส่งจนกว่าจะเสร็จ/พังจริง) —
    // ใช้กันไม่ให้ realtime sync เอาข้อมูลเก่ามาทับระหว่างที่ยังส่งไม่เสร็จ (ดู subscribeRealtime ด้านล่าง)
    pendingSaveCount++;
    supabaseClient.from('user_data').upsert({ id: currentUserId, data: payload, updated_at: new Date().toISOString() }).then(function(res){
      pendingSaveCount--;
      if (res.error) { console.error('save error', res.error); showToast('ซิงค์ข้อมูลไม่สำเร็จ: ' + res.error.message, 'error'); }
    }).catch(function(err){
      pendingSaveCount--;
      console.error('save error', err);
      showToast('ซิงค์ข้อมูลไม่สำเร็จ: ' + (err && err.message ? err.message : err), 'error');
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
        // ถ้าเครื่องนี้เพิ่งแก้ไขข้อมูลแล้วยังไม่ได้ sync รอบใหม่ (saveTimer ค้างอยู่) หรือกำลังส่งข้อมูลไปเซิร์ฟเวอร์
        // อยู่ ณ ตอนนี้ (pendingSaveCount > 0 เช่น ตอนเน็ตหลุด/กำลัง retry) ห้ามเอาข้อมูลที่เพิ่งมาถึง
        // (ซึ่งอาจเป็นแค่ echo ของการ save รอบก่อนหน้าของตัวเราเอง หรือข้อมูลเก่าที่เพิ่ง sync เสร็จช้ากว่ารอบใหม่)
        // มาทับ state ปัจจุบัน เพราะจะทำให้การแก้ไขล่าสุดหายไปเงียบๆ
        if (saveTimer || pendingSaveCount > 0) return;
        var newData = payload.new && payload.new.data;
        if (!newData) return;
        Store.collections.forEach(function(name){ state[name] = newData[name] || {}; });
        renderTab();
      })
      .subscribe();
  }

  function updateSyncStatus() {
    var syncText = currentUserEmail ? ('ซิงค์แล้ว · ' + currentUserEmail) : 'ยังไม่ได้เข้าสู่ระบบ';
    document.querySelectorAll('.sync-status').forEach(function(el){ el.textContent = syncText; });
  }

  function onDataChange() {
    maybeSeedDefaults();
    maybeCleanupInvestmentData();
    maybeProcessRecurring();
    renderTab();
  }

  // ตอนฟีเจอร์ "ลงทุน" ถูกถอดออกไปชั่วคราว (Ver8) มีการล้างรายการซื้อ/ขาย/ปันผลเก่าที่ตกค้างทิ้งครั้งเดียว
  // เพื่อกัน type:'investment' รุ่นเก่าที่โครงสร้างไม่ตรงกับ Store.collections ตอนนั้นมาปนกับข้อมูลปัจจุบัน
  // ตอนนี้ฟีเจอร์กลับมาแล้วด้วยโครงสร้างใหม่ (ดู claude/investment-feature-redesign.md) — ฟังก์ชันนี้ยังคงไว้
  // เป็น one-time migration guard เฉยๆ (flag investmentDataCleaned กันไม่ให้รันซ้ำ) ไม่กระทบธุรกรรมลงทุนใหม่ที่สร้างจากนี้ไป
  var investmentCleanupAttempted = false;
  function maybeCleanupInvestmentData() {
    if (investmentCleanupAttempted) return;
    if (!state.ready.transactions || !state.ready.meta) return;
    investmentCleanupAttempted = true;
    if (state.meta.app && state.meta.app.investmentDataCleaned) return;
    Object.keys(state.transactions).forEach(function(id){
      if (state.transactions[id].type === 'investment') delete state.transactions[id];
    });
    state.meta.app = Object.assign({id:'app'}, state.meta.app, {investmentDataCleaned:true});
    scheduleSave();
  }

  function markSeeded() {
    state.meta.app = Object.assign({id:'app'}, state.meta.app, {seeded:true});
    scheduleSave();
  }

  function maybeSeedDefaults() {
    if (seedAttempted) return;
    if (!state.ready.accounts || !state.ready.categories || !state.ready.meta) return;
    seedAttempted = true;
    // เคยสร้างค่าเริ่มต้นให้ไปแล้วครั้งหนึ่ง (แม้ผู้ใช้จะลบบัญชี/หมวดหมู่ทั้งหมดทิ้งภายหลัง) — ไม่สร้างซ้ำอีก
    if (state.meta.app && state.meta.app.seeded) return;
    if (Object.keys(state.accounts).length > 0 || Object.keys(state.categories).length > 0) { markSeeded(); return; }
    defaultAccounts.forEach(function(a){ Store.add('accounts', a); });
    defaultCategories.forEach(function(c){ Store.add('categories', c); });
    markSeeded();
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
  function isCreditDebtId(id) {
    return typeof id === 'string' && id.indexOf('credit:') === 0;
  }

  function updateFabVisibility() {
    // บัตรเครดิตคำนวณยอดสดจากบัญชี ไม่มีฟอร์ม "บันทึกการผ่อนชำระ" ให้ใช้ — ซ่อนปุ่ม + ตอนดูรายละเอียดบัตรเครดิต
    // กันไม่ให้กด + แล้วไปเปิดฟอร์มผ่อนชำระผูกกับ debtId ปลอมที่ไม่มีอยู่จริง (เช่น "credit:xxx")
    // แท็บลงทุนมีปุ่มทำรายการของตัวเอง (เพิ่มสินทรัพย์/ซื้อขาย/อัปเดตราคา) ไม่ใช้ปุ่ม + ลอยทั่วไป
    var hide = currentTab === 'settings' || currentTab === 'investments' || (currentTab === 'debts' && isCreditDebtId(selectedDebtId));
    fabWrapEl.classList.toggle('hidden', hide);
    if (sideFabBtnEl) sideFabBtnEl.classList.toggle('hidden', hide);
  }

  function switchTab(tab) {
    currentTab = tab;
    if (tab === 'debts') selectedDebtId = null;
    document.querySelectorAll('.tab-btn').forEach(function(b){
      b.classList.toggle('active', b.dataset.tab === tab);
    });
    renderTab();
  }

  function renderTab() {
    tabContentEl.classList.toggle('grid-tab', currentTab === 'dashboard' || currentTab === 'debts' || currentTab === 'investments' || currentTab === 'settings');
    tabContentEl.classList.toggle('tx-grid', currentTab === 'transactions');
    if (!allReady()) {
      tabContentEl.innerHTML = '<div class="card"><div class="empty-note">กำลังโหลดข้อมูล...</div></div>';
      return;
    }
    if (currentTab === 'dashboard') tabContentEl.innerHTML = renderDashboard();
    else if (currentTab === 'transactions') tabContentEl.innerHTML = renderTransactions();
    else if (currentTab === 'investments') tabContentEl.innerHTML = renderInvestments();
    else if (currentTab === 'debts') tabContentEl.innerHTML = renderDebts();
    else tabContentEl.innerHTML = renderSettings();
    // renderDebts() อาจรีเซ็ต selectedDebtId เองถ้า id ไม่ถูกต้อง เรียกหลัง render เสมอเพื่อให้ปุ่ม + ตรงกับสถานะจริง
    updateFabVisibility();
  }

  function txRow(t) {
    if (t.type === 'transfer') {
      var fromAcc = state.accounts[t.fromAccountId];
      var toAcc = state.accounts[t.toAccountId];
      var tSub = [(fromAcc ? escapeHtml(fromAcc.name) : '?') + ' → ' + (toAcc ? escapeHtml(toAcc.name) : '?')];
      if (t.note) tSub.push(escapeHtml(t.note));
      return '' +
        '<div class="tx-row" data-action="edit-tx" data-id="' + t.id + '">' +
          '<div class="tx-main">' +
            '<div class="tx-cat">⇄ โอนเงิน</div>' +
            '<div class="tx-sub">' + tSub.join(' · ') + '</div>' +
          '</div>' +
          '<div class="tx-side">' +
            '<div class="tx-amt transfer-text">' + fmtMoney(Number(t.amount)) + '</div>' +
            '<div class="tx-date">' + fmtDateShort(t.date) + '</div>' +
          '</div>' +
        '</div>';
    }
    if (t.type === 'investment') {
      var holding = state.holdings[t.holdingId];
      var actionLabel = {buy:'ซื้อ', sell:'ขาย', dividend:'ปันผล'}[t.investAction] || '';
      var invAcc = state.accounts[t.accountId];
      var invSub = [];
      if (invAcc) invSub.push(escapeHtml(invAcc.name));
      if (t.note) invSub.push(escapeHtml(t.note));
      var invSign = t.investAction === 'buy' ? '-' : '+';
      var invCls = t.investAction === 'buy' ? 'expense-text' : 'income-text';
      return '' +
        '<div class="tx-row" data-action="view-invest-tx" data-id="' + (t.invTxnId || '') + '">' +
          '<div class="tx-main">' +
            '<div class="tx-cat">📈 ' + escapeHtml(holding ? holding.name : 'ไม่พบสินทรัพย์') + ' · ' + actionLabel + '</div>' +
            '<div class="tx-sub">' + invSub.join(' · ') + '</div>' +
          '</div>' +
          '<div class="tx-side">' +
            '<div class="tx-amt ' + invCls + '">' + invSign + fmtInvMoney(Number(t.amount)) + '</div>' +
            '<div class="tx-date">' + fmtDateShort(t.date) + '</div>' +
          '</div>' +
        '</div>';
    }
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
    var investValue = totalInvestmentValue();
    var debtRemainingTotal = totalDebtRemaining();
    var netWorth = cash + investValue - debtRemainingTotal;

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
        (Object.keys(state.holdings).length ? '<div><span class="dot dot-invest"></span>ลงทุน ' + fmtInvMoney(investValue) + '</div>' : '') +
        (Object.keys(state.debts).length ? '<div><span class="dot dot-debt"></span>หนี้คงเหลือ -' + fmtMoney(debtRemainingTotal) + '</div>' : '') +
      '</div></div>';

    html += '<div class="grid-2">' +
      '<div class="card stat-card"><div class="stat-label">รายรับเดือนนี้</div><div class="stat-value income-text">' + fmtMoney(income) + '</div></div>' +
      '<div class="card stat-card"><div class="stat-label">รายจ่ายเดือนนี้</div><div class="stat-value expense-text">' + fmtMoney(expense) + '</div></div>' +
    '</div>';

    html += renderExpenseTrendCard();
    html += renderBudgetCard();

    html += renderInvestSummaryCard();
    html += renderDebtSummaryCard();

    html += '<div class="card recent-list">' +
      '<div class="card-title-row"><div class="card-title">รายการล่าสุด</div>' +
      '<button class="link-btn" data-action="go-tab" data-tab="transactions">ดูทั้งหมด</button></div>' +
      (recent.length ? recent.map(txRow).join('') : '<div class="empty-note">ยังไม่มีรายการ</div>') +
    '</div>';

    return html;
  }

  function renderDebtSummaryCard() {
    var debts = Object.values(state.debts);
    var creditAccs = creditAccounts().filter(function(a){ return creditDebtRemaining(a) > 0; });
    if (!debts.length && !creditAccs.length) return '';
    var totalRemaining = totalDebtRemaining() + totalCreditDebtRemaining();
    var rows = debts.map(function(d){
      var paid = debtPaidPrincipal(d.id);
      var pct = Number(d.principal) > 0 ? Math.min(100, paid / Number(d.principal) * 100) : 0;
      return '<div class="debt-mini-row">' +
        '<div class="debt-mini-name">' + escapeHtml(d.name) + '</div>' +
        '<div class="progress-track"><div class="progress-fill" style="width:' + pct.toFixed(0) + '%"></div></div>' +
        '<div class="debt-mini-val">' + fmtMoney(debtRemaining(d)) + '</div>' +
      '</div>';
    }).join('');
    var creditRows = creditAccs.map(function(a){
      return '<div class="debt-mini-row">' +
        '<div class="debt-mini-name">💳 ' + escapeHtml(a.name) + '</div>' +
        '<div class="progress-track"></div>' +
        '<div class="debt-mini-val">' + fmtMoney(creditDebtRemaining(a)) + '</div>' +
      '</div>';
    }).join('');
    return '<div class="card wide-card">' +
      '<div class="card-title-row"><div class="card-title">หนี้</div>' +
      '<div class="expense-text small-bold">-' + fmtMoney(totalRemaining) + '</div></div>' +
      rows + creditRows +
    '</div>';
  }

  function renderInvestSummaryCard() {
    var holdings = Object.values(state.holdings);
    if (!holdings.length) return '';
    var totalValue = totalInvestmentValue();
    var totalCostVal = totalInvestmentCostAll();
    var pl = totalValue - totalCostVal;
    return '<div class="card wide-card invest-hero">' +
      '<div class="card-title-row"><div class="card-title">การลงทุน</div>' +
      '<button class="link-btn" data-action="go-tab" data-tab="investments">ดูทั้งหมด</button></div>' +
      '<div class="hero-value" style="margin-top:4px">' + fmtInvMoney(totalValue) + '</div>' +
      '<div class="hero-split"><div class="' + (pl>=0?'income-text':'expense-text') + '">' + (pl>=0?'+':'') + fmtInvMoney(pl) + ' กำไร/ขาดทุนรวม</div></div>' +
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
      return '<div class="card wide-card"><div class="card-title">แนวโน้มรายจ่ายตามหมวด</div><div class="empty-note">ยังไม่มีข้อมูลรายจ่ายให้แสดงแนวโน้ม</div></div>';
    }

    return '<div class="card wide-card">' +
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

    return '<div class="card wide-card"><div class="card-title">งบประมาณเดือนนี้</div>' + rowsHtml + '</div>';
  }

  function renderTransactions() {
    var monthLabel = new Date(txFilter.month + '-01').toLocaleDateString('th-TH', {month:'long', year:'numeric'});
    var list = transactionsForMonth(txFilter.month);
    if (txFilter.type !== 'all') list = list.filter(function(t){ return t.type === txFilter.type; });
    if (txFilter.accountId !== 'all') list = list.filter(function(t){
      if (t.type === 'transfer') return t.fromAccountId === txFilter.accountId || t.toAccountId === txFilter.accountId;
      return t.accountId === txFilter.accountId;
    });
    list.sort(function(a,b){ return (b.date||'').localeCompare(a.date||''); });

    var income = list.filter(function(t){ return t.type==='income'; }).reduce(function(s,t){ return s+Number(t.amount); },0);
    var expense = list.filter(function(t){ return t.type==='expense'; }).reduce(function(s,t){ return s+Number(t.amount); },0);

    var accOptions = Object.values(state.accounts).map(function(a){
      return '<option value="' + a.id + '"' + (txFilter.accountId===a.id?' selected':'') + '>' + escapeHtml(a.name) + '</option>';
    }).join('');

    // จอกว้าง: ย้ายการ์ดสรุป (รายรับ/รายจ่าย) + ตัวกรอง + ลิงก์โอนเงิน ไปไว้คอลัมน์ซ้ายแคบ (.tx-col-left)
    // รายการทั้งหมดอยู่คอลัมน์ขวา เต็มความสูง (ดู .tab-content.tx-grid ใน style.css) — มือถือยังเรียงต่อกันลงมาเหมือนเดิม
    var html = '';
    html += '<div class="month-nav">' +
      '<button class="icon-btn" data-action="month-prev">‹</button>' +
      '<div class="month-label">' + monthLabel + '</div>' +
      '<button class="icon-btn" data-action="month-next">›</button>' +
    '</div>';

    var left = '';
    left += '<div class="grid-2">' +
      '<div class="card stat-card"><div class="stat-label">รายรับ</div><div class="stat-value income-text">' + fmtMoney(income) + '</div></div>' +
      '<div class="card stat-card"><div class="stat-label">รายจ่าย</div><div class="stat-value expense-text">' + fmtMoney(expense) + '</div></div>' +
    '</div>';
    left += '<div class="filter-row">' +
      '<select class="select-sm" data-action="filter-type">' +
        '<option value="all"' + (txFilter.type==='all'?' selected':'') + '>ทุกประเภท</option>' +
        '<option value="income"' + (txFilter.type==='income'?' selected':'') + '>รายรับ</option>' +
        '<option value="expense"' + (txFilter.type==='expense'?' selected':'') + '>รายจ่าย</option>' +
        '<option value="transfer"' + (txFilter.type==='transfer'?' selected':'') + '>โอนเงิน</option>' +
        '<option value="investment"' + (txFilter.type==='investment'?' selected':'') + '>ลงทุน</option>' +
      '</select>' +
      '<select class="select-sm" data-action="filter-account">' +
        '<option value="all"' + (txFilter.accountId==='all'?' selected':'') + '>ทุกบัญชี</option>' + accOptions +
      '</select>' +
    '</div>';
    left += '<div class="card-title-row list-header"><span></span><button class="link-btn" data-action="add-transfer">⇄ โอนเงินระหว่างบัญชี</button></div>';
    html += '<div class="tx-col-left">' + left + '</div>';

    html += '<div class="tx-col-right"><div class="card list-card">' +
      (list.length ? list.map(txRow).join('') : '<div class="empty-note">ไม่มีรายการในเดือนนี้</div>') +
    '</div></div>';
    return html;
  }

  function renderInvestments() {
    var holdings = Object.values(state.holdings);
    var html = '';
    if (!holdings.length) {
      html += '<div class="card-title-row list-header"><div class="card-title">ลงทุน</div>' +
        '<button class="link-btn" data-action="add-holding">+ เพิ่มสินทรัพย์</button></div>';
      html += '<div class="card wide-card"><div class="empty-note">ยังไม่มีสินทรัพย์ลงทุน แตะ "+ เพิ่มสินทรัพย์" เพื่อเริ่มบันทึก</div></div>';
      return html;
    }

    var byGroup = {};
    assetGroups.forEach(function(g){ byGroup[g.key] = []; });
    holdings.forEach(function(h){
      var c = holdingComputed(h.id);
      var price = holdingPrice(h);
      var value = c.qty * price;
      var cost = c.qty * c.avgCost;
      var group = assetGroups.filter(function(g){ return g.types.indexOf(h.assetType) !== -1; })[0] || assetGroups[0];
      byGroup[group.key].push({ holding:h, qty:c.qty, avgCost:c.avgCost, price:price, value:value, cost:cost });
    });

    var totalValue = totalInvestmentValue();
    var totalCostVal = totalInvestmentCostAll();
    var totalPL = totalValue - totalCostVal;
    var totalPLPct = totalCostVal > 0 ? (totalPL / totalCostVal * 100) : 0;

    html += '<div class="card hero-card invest-hero">' +
      '<div class="hero-label">มูลค่าพอร์ตรวม</div>' +
      '<div class="hero-value">' + fmtInvMoney(totalValue) + '</div>' +
      '<div class="hero-split">' +
        '<div class="' + (totalPL>=0?'income-text':'expense-text') + '">' + (totalPL>=0?'+':'') + fmtInvMoney(totalPL) + ' (' + (totalPL>=0?'+':'') + totalPLPct.toFixed(1) + '%)</div>' +
        '<div>ต้นทุนรวม ' + fmtInvMoney(totalCostVal) + '</div>' +
      '</div></div>';

    html += '<div class="card-title-row list-header"><div class="card-title"></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
        '<button class="link-btn" data-action="update-all-prices">อัปเดตราคาทั้งหมด</button>' +
        '<button class="link-btn" data-action="add-holding">+ เพิ่มสินทรัพย์</button>' +
      '</div></div>';

    assetGroups.forEach(function(g){
      var items = byGroup[g.key];
      if (!items.length) return;
      var groupValue = items.reduce(function(s,it){ return s+it.value; }, 0);
      html += '<div class="card-title-row list-header"><div class="card-title">' + g.label + '</div>' +
        '<div class="small-bold">' + fmtInvMoney(groupValue) + '</div></div>';
      html += items.map(holdingCard).join('');
    });

    return html;
  }

  function holdingCard(it) {
    var h = it.holding;
    var pl = it.value - it.cost;
    var plPct = it.cost > 0 ? (pl / it.cost * 100) : 0;
    var plCls = pl >= 0 ? 'income-text' : 'expense-text';
    var stale = isPriceStale(h);
    var priceLabel = h.lastPriceDate ? ('ราคาล่าสุด ณ ' + fmtDateShort(h.lastPriceDate)) : 'ยังไม่เคยอัปเดตราคา (ใช้ต้นทุนเฉลี่ยแทนชั่วคราว)';
    return '<div class="card holding-card">' +
      '<div class="holding-top" data-action="edit-holding" data-id="' + h.id + '">' +
        '<div>' +
          '<div class="holding-name">' + escapeHtml(h.name) + '<span class="tag">' + (assetTypeLabels[h.assetType]||'') + '</span></div>' +
          '<div class="holding-sub' + (stale ? ' expense-text' : '') + '">' + priceLabel + (stale && h.lastPriceDate ? ' · เกิน ' + PRICE_STALE_DAYS + ' วันแล้ว' : '') + '</div>' +
        '</div>' +
        '<div class="holding-value-col">' +
          '<div class="holding-value">' + fmtInvMoney(it.value) + '</div>' +
          '<div class="' + plCls + '" style="font-size:12px">' + (pl>=0?'+':'') + fmtInvMoney(pl) + ' (' + (pl>=0?'+':'') + plPct.toFixed(1) + '%)</div>' +
        '</div>' +
      '</div>' +
      '<div class="holding-meta">' +
        '<span>จำนวน ' + fmtQty(it.qty) + (h.unit?(' '+escapeHtml(h.unit)):'') + '</span>' +
        '<span>ต้นทุนเฉลี่ย ' + fmtInvMoney(it.avgCost) + '</span>' +
        '<span>ราคาล่าสุด ' + fmtInvMoney(it.price) + '</span>' +
      '</div>' +
      '<div class="holding-actions">' +
        '<button type="button" class="chip-btn" data-action="add-invest-tx" data-id="' + h.id + '">ซื้อ/ขาย/ปันผล</button>' +
        '<button type="button" class="chip-btn" data-action="update-price" data-id="' + h.id + '">อัปเดตราคา</button>' +
      '</div>' +
    '</div>';
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
        '<div class="debt-name-wrap">' +
          '<div class="debt-icon home">🏠</div>' +
          '<div class="debt-name-col"><div class="debt-name">' + escapeHtml(d.name) + '</div><div class="debt-kind">หนี้ระยะยาว · ผ่อนตามงวด</div></div>' +
        '</div>' +
        '<div class="debt-remaining">' + fmtMoney(remaining) + '<span class="debt-remaining-label">คงเหลือ</span></div>' +
      '</div>' +
      '<div class="progress-track"><div class="progress-fill" style="width:' + pct.toFixed(0) + '%"></div></div>' +
      '<div class="debt-meta"><span>ยอดกู้ ' + fmtMoney(d.principal) + '</span><span>ผ่อนแล้ว ' + pct.toFixed(0) + '%</span></div>' +
    '</div>';
  }

  function creditDebtCard(acc) {
    var remaining = creditDebtRemaining(acc);
    var last = lastTxDateForAccount(acc.id);
    return '<div class="card debt-card" data-action="view-debt" data-id="credit:' + acc.id + '">' +
      '<div class="debt-card-top">' +
        '<div class="debt-name-wrap">' +
          '<div class="debt-icon credit">💳</div>' +
          '<div class="debt-name-col"><div class="debt-name">' + escapeHtml(acc.name) + '</div><div class="debt-kind">บัตรเครดิต · หมุนเวียน</div></div>' +
        '</div>' +
        '<div class="debt-remaining">' + fmtMoney(remaining) + '<span class="debt-remaining-label">คงเหลือ</span></div>' +
      '</div>' +
      '<div class="credit-foot"><span class="live-tag"><span class="live-dot"></span>คำนวณสดจากยอดบัญชี</span><span>รายการล่าสุด ' + fmtRelativeDate(last) + '</span></div>' +
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
    var creditAccs = creditAccounts();
    var html = '<div class="card-title-row list-header"><div class="card-title">หนี้ของฉัน</div>' +
      '<button class="link-btn" data-action="add-debt">+ เพิ่มหนี้</button></div>';
    if (!debts.length && !creditAccs.length) {
      html += '<div class="card wide-card">' +
        '<div class="empty-note">ยังไม่มีข้อมูลหนี้ แตะ "+ เพิ่มหนี้" เพื่อเริ่มบันทึกเอง</div>' +
        '<button class="secondary-btn full-btn" data-action="import-house-loan">นำเข้าข้อมูลผ่อนบ้านจากไฟล์ที่แนบไว้</button>' +
      '</div>';
      return html;
    }
    var totalHouse = totalDebtRemaining();
    var totalCredit = totalCreditDebtRemaining();
    var grandTotal = totalHouse + totalCredit;
    if (grandTotal > 0) {
      html += '<div class="card hero-card debt-hero">' +
        '<div class="hero-label">หนี้คงเหลือทั้งหมด</div>' +
        '<div class="hero-value">' + fmtMoney(grandTotal) + '</div>' +
        '<div class="hero-split">' +
          (totalHouse ? '<div><span class="dot dot-home"></span>หนี้ระยะยาว ' + fmtMoney(totalHouse) + '</div>' : '') +
          (totalCredit ? '<div><span class="dot dot-credit"></span>บัตรเครดิต ' + fmtMoney(totalCredit) + '</div>' : '') +
        '</div></div>';
    }
    html += debts.map(debtCard).join('');
    html += creditAccs.map(creditDebtCard).join('');
    return html;
  }

  function renderCreditDebtDetail(acc) {
    var remaining = creditDebtRemaining(acc);
    var txs = Object.values(state.transactions).filter(function(t){
      return t.type === 'transfer' ? (t.fromAccountId === acc.id || t.toAccountId === acc.id) : t.accountId === acc.id;
    }).sort(function(a,b){ return (b.date||'').localeCompare(a.date||''); }).slice(0, 30);

    var html = '';
    html += '<div class="detail-nav"><button class="link-btn" data-action="back-to-debts">‹ หนี้ทั้งหมด</button>' +
      '<button class="icon-btn" data-action="edit-account" data-id="' + acc.id + '">✎</button></div>';

    html += '<div class="card hero-card debt-hero">' +
      '<div class="hero-label">' + escapeHtml(acc.name) + ' · คงเหลือ</div>' +
      '<div class="hero-value">' + fmtMoney(remaining) + '</div>' +
      '<div class="hero-split"><span class="live-tag"><span class="live-dot"></span>คำนวณสดจากยอดบัญชี ไม่ต้องบันทึกแยก</span></div>' +
    '</div>';

    html += '<div class="card wide-card">' +
      '<div class="card-title">จ่ายบิลบัตรนี้</div>' +
      '<div class="tax-note">กดปุ่ม "⇄ โอนเงินระหว่างบัญชี" ในแท็บ "รายการ" เพื่อโอนจากบัญชีธนาคารมาลดยอดบัตรใบนี้ — ยอดคงเหลือด้านบนจะปรับตามทันที ไม่ต้องบันทึกเป็นรายจ่ายซ้ำ</div>' +
    '</div>';

    html += '<div class="card-title-row list-header"><div class="card-title">รายการล่าสุดในบัญชีนี้</div></div>';
    html += '<div class="card list-card">' + (txs.length ? txs.map(txRow).join('') : '<div class="empty-note">ยังไม่มีรายการ</div>') + '</div>';

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

    html += '<div class="card wide-card">' +
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
    if (typeof selectedDebtId === 'string' && selectedDebtId.indexOf('credit:') === 0) {
      var creditAcc = state.accounts[selectedDebtId.slice(7)];
      if (creditAcc) return renderCreditDebtDetail(creditAcc);
      selectedDebtId = null;
    }
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

    // ฝั่งซ้าย: บัญชี/กระเป๋าเงิน + หมวดรายรับ, ฝั่งขวา: หมวดรายจ่าย + งบประมาณรายเดือน
    // (ห่อด้วย .settings-col เพื่อไม่ให้ .list-header/.list-card ข้างในถูกขยายเต็มความกว้างอัตโนมัติจาก .grid-tab)
    var left = '';
    left += '<div class="card-title-row list-header"><div class="card-title">บัญชี/กระเป๋าเงิน</div>' +
      '<button class="link-btn" data-action="add-account">+ เพิ่มบัญชี</button></div>';
    left += '<div class="card list-card">' + (accs.length ? accs.map(function(a){
      return '<div class="settings-row" data-action="edit-account" data-id="' + a.id + '">' +
        '<div><div class="settings-row-title">' + escapeHtml(a.name) + '</div>' +
        '<div class="settings-row-sub">' + (accountTypeLabels[a.type]||'อื่นๆ') + '</div></div>' +
        '<div class="settings-row-val">' + fmtMoney(accountBalance(a.id)) + '</div></div>';
    }).join('') : '<div class="empty-note">ยังไม่มีบัญชี</div>') + '</div>';

    left += '<div class="card-title-row list-header"><div class="card-title">หมวดรายรับ</div>' +
      '<button class="link-btn" data-action="add-category" data-cattype="income">+ เพิ่ม</button></div>';
    left += '<div class="card list-card">' + (incomeCats.length ? incomeCats.map(catRow).join('') : '<div class="empty-note">ยังไม่มีหมวดรายรับ</div>') + '</div>';

    var right = '';
    right += '<div class="card-title-row list-header"><div class="card-title">หมวดรายจ่าย</div>' +
      '<button class="link-btn" data-action="add-category" data-cattype="expense">+ เพิ่ม</button></div>';
    right += '<div class="card list-card">' + (expenseCats.length ? expenseCats.map(catRow).join('') : '<div class="empty-note">ยังไม่มีหมวดรายจ่าย</div>') + '</div>';

    right += '<div class="card-title-row list-header"><div class="card-title">งบประมาณรายเดือน</div></div>';
    right += '<div class="card list-card">' + (expenseCats.length ? expenseCats.map(budgetRow).join('') : '<div class="empty-note">เพิ่มหมวดรายจ่ายก่อนเพื่อตั้งงบประมาณ</div>') + '</div>';

    var html = '';
    html += '<div class="settings-col">' + left + '</div>';
    html += '<div class="settings-col">' + right + '</div>';

    // ด้านล่าง: รายการที่เกิดซ้ำทุกเดือน + บัญชีผู้ใช้ อยู่ตำแหน่งเดิม แต่ขยายเต็มความกว้างในจอกว้าง (ตาม .list-header/.list-card ที่เป็น direct child ของ .grid-tab)
    html += '<div class="card-title-row list-header"><div class="card-title">รายการที่เกิดซ้ำทุกเดือน</div>' +
      '<button class="link-btn" data-action="add-recurring">+ เพิ่ม</button></div>';
    var recurringList = Object.values(state.recurringTemplates);
    html += '<div class="card list-card">' + (recurringList.length ? recurringList.map(recurringRow).join('') : '<div class="empty-note">ยังไม่มีรายการที่เกิดซ้ำ เช่น ค่าเช่า ค่าบริการรายเดือน</div>') + '</div>';

    html += '<div class="card-title-row list-header"><div class="card-title">บัญชีผู้ใช้</div></div>';
    html += '<div class="card wide-card">' +
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

  // ---------- modal building blocks (refactor: ลดโค้ด HTML ที่ซ้ำกันในทุกฟอร์ม) ----------
  // ทุกโมดัลด้านล่างประกอบจากฟังก์ชันกลางชุดนี้แทนการต่อ string ซ้ำๆ เอง —
  // เปลี่ยนโครงสร้าง field/ปุ่ม ให้แก้ที่เดียวตรงนี้แล้วมีผลทุกฟอร์ม
  function modalHeader(title) {
    return '<div class="modal-header"><div class="modal-title">' + title + '</div>' +
      '<button type="button" class="icon-btn" data-action="close-modal">✕</button></div>';
  }
  function hiddenField(name, value) {
    return '<input type="hidden" name="' + name + '" value="' + value + '">';
  }
  function fieldWrap(label, innerHtml) {
    return '<label class="field"><span>' + label + '</span>' + innerHtml + '</label>';
  }
  function fieldDisplay(label, valueHtml) {
    return '<label class="field"><span>' + label + '</span><div>' + valueHtml + '</div></label>';
  }
  function numberField(label, name, opts) {
    opts = opts || {};
    var val = opts.value != null ? opts.value : '';
    var required = opts.required !== false;
    return fieldWrap(label, '<input type="number" step="any" min="0" name="' + name + '"' + (required ? ' required' : '') +
      ' value="' + val + '" placeholder="' + (opts.placeholder != null ? opts.placeholder : '0.00') + '">');
  }
  function textField(label, name, opts) {
    opts = opts || {};
    return fieldWrap(label, '<input type="text" name="' + name + '"' + (opts.required ? ' required' : '') +
      ' value="' + escapeHtml(opts.value || '') + '" placeholder="' + (opts.placeholder || '') + '">');
  }
  function dateField(label, name, value, required) {
    return fieldWrap(label, '<input type="date" name="' + name + '"' + (required !== false ? ' required' : '') +
      ' value="' + (value || '') + '">');
  }
  function selectField(label, name, optionsHtml, required) {
    return fieldWrap(label, '<select name="' + name + '"' + (required !== false ? ' required' : '') + '>' + optionsHtml + '</select>');
  }
  function optionsFromList(list, selectedId, labelFn) {
    return list.map(function(item){
      return '<option value="' + item.id + '"' + (selectedId === item.id ? ' selected' : '') + '>' + escapeHtml(labelFn(item)) + '</option>';
    }).join('');
  }
  function accountOptions(selectedId) {
    return optionsFromList(Object.values(state.accounts), selectedId, function(a){ return a.name; });
  }
  function categoryOptionsByType(type, selectedId) {
    var cats = Object.values(state.categories).filter(function(c){ return c.type === type; });
    return optionsFromList(cats, selectedId, function(c){ return c.name; });
  }
  function labelOptions(labelMap, selectedKey) {
    return Object.keys(labelMap).map(function(k){
      return '<option value="' + k + '"' + (selectedKey === k ? ' selected' : '') + '>' + labelMap[k] + '</option>';
    }).join('');
  }
  function typeToggle(dataAction, options, current) {
    return '<div class="type-toggle">' + options.map(function(o){
      var active = o.type === current;
      return '<button type="button" class="type-btn' + (active ? ' active' + (o.activeClass ? ' ' + o.activeClass : '') : '') +
        '" data-action="' + dataAction + '" data-type="' + o.type + '">' + o.label + '</button>';
    }).join('') + '</div>';
  }
  function deleteBtn(action, id, label) {
    return '<button type="button" class="danger-btn" data-action="' + action + '" data-id="' + id + '">' + (label || 'ลบ') + '</button>';
  }
  function modalActions(deleteBtnHtml) {
    return '<div class="modal-actions">' + (deleteBtnHtml || '<span></span>') + '<button type="submit" class="primary-btn">บันทึก</button></div>';
  }
  var incomeExpenseToggle = [
    { type: 'expense', label: 'รายจ่าย', activeClass: 'expense' },
    { type: 'income', label: 'รายรับ', activeClass: 'income' }
  ];

  function transactionModal(existing) {
    existing = existing || {};
    var isEdit = !!existing.id;
    var type = existing.type || 'expense';
    return '' +
      '<form id="txForm" class="modal-form">' +
        modalHeader(isEdit ? 'แก้ไขรายการ' : 'เพิ่มรายรับ-รายจ่าย') +
        typeToggle('tx-type', incomeExpenseToggle, type) +
        hiddenField('type', type) +
        (isEdit ? hiddenField('id', existing.id) : '') +
        numberField('จำนวนเงิน', 'amount', { value: existing.amount != null ? existing.amount : '' }) +
        selectField('บัญชี', 'accountId', accountOptions(existing.accountId)) +
        selectField('หมวดหมู่', 'categoryId', categoryOptionsByType(type, existing.categoryId)) +
        dateField('วันที่', 'date', existing.date ? existing.date.slice(0,10) : todayISO()) +
        textField('โน้ต (ไม่บังคับ)', 'note', { value: existing.note || '', placeholder: 'รายละเอียดเพิ่มเติม' }) +
        modalActions(isEdit ? deleteBtn('delete-tx', existing.id) : null) +
      '</form>';
  }

  function accountModal(existing) {
    existing = existing || null;
    return '' +
      '<form id="accountForm" class="modal-form">' +
        modalHeader(existing ? 'แก้ไขบัญชี' : 'เพิ่มบัญชี') +
        (existing ? hiddenField('id', existing.id) : '') +
        textField('ชื่อบัญชี', 'name', { value: existing ? existing.name : '', required: true, placeholder: 'เช่น บัญชีออมทรัพย์' }) +
        selectField('ประเภท', 'type', labelOptions(accountTypeLabels, existing && existing.type), false) +
        modalActions(existing ? deleteBtn('delete-account', existing.id) : null) +
      '</form>';
  }

  function categoryModal(existing, defaultType) {
    existing = existing || null;
    var type = (existing && existing.type) || defaultType || 'expense';
    return '' +
      '<form id="categoryForm" class="modal-form">' +
        modalHeader(existing ? 'แก้ไขหมวดหมู่' : 'เพิ่มหมวดหมู่') +
        (existing ? hiddenField('id', existing.id) : '') +
        hiddenField('type', type) +
        textField('ชื่อหมวดหมู่ (' + (type === 'income' ? 'รายรับ' : 'รายจ่าย') + ')', 'name', { value: existing ? existing.name : '', required: true, placeholder: 'เช่น อาหาร' }) +
        modalActions(null) +
      '</form>';
  }

  function transferModal(existing) {
    existing = existing || {};
    var isEdit = !!existing.id;
    return '' +
      '<form id="transferForm" class="modal-form">' +
        modalHeader(isEdit ? 'แก้ไขการโอนเงิน' : 'โอนเงินระหว่างบัญชี') +
        (isEdit ? hiddenField('id', existing.id) : '') +
        numberField('จำนวนเงิน', 'amount', { value: existing.amount != null ? existing.amount : '' }) +
        selectField('จากบัญชี', 'fromAccountId', accountOptions(existing.fromAccountId)) +
        selectField('ไปบัญชี (เช่น บัตรเครดิตที่จะจ่ายบิล)', 'toAccountId', accountOptions(existing.toAccountId)) +
        dateField('วันที่', 'date', existing.date ? existing.date.slice(0,10) : todayISO()) +
        textField('โน้ต (ไม่บังคับ)', 'note', { value: existing.note || '', placeholder: 'เช่น จ่ายบิลบัตรเครดิต' }) +
        modalActions(isEdit ? deleteBtn('delete-tx', existing.id) : null) +
      '</form>';
  }

  function debtModal(existing) {
    existing = existing || null;
    return '' +
      '<form id="debtForm" class="modal-form">' +
        modalHeader(existing ? 'แก้ไขหนี้' : 'เพิ่มหนี้ใหม่') +
        (existing ? hiddenField('id', existing.id) : '') +
        textField('ชื่อรายการหนี้', 'name', { value: existing ? existing.name : '', required: true, placeholder: 'เช่น ผ่อนบ้าน, สินเชื่อรถ' }) +
        numberField('ยอดกู้ตั้งต้น', 'principal', { value: existing ? existing.principal : '' }) +
        dateField('วันที่เริ่มกู้ (ไม่บังคับ)', 'startDate', existing && existing.startDate ? existing.startDate.slice(0,10) : '', false) +
        textField('โน้ต (ไม่บังคับ)', 'note', { value: existing ? (existing.note || '') : '', placeholder: 'เช่น ชื่อธนาคาร' }) +
        modalActions(existing ? deleteBtn('delete-debt', existing.id) : null) +
      '</form>';
  }

  function paymentModal(existing, debtId) {
    existing = existing || null;
    return '' +
      '<form id="paymentForm" class="modal-form">' +
        modalHeader(existing ? 'แก้ไขรายการผ่อนชำระ' : 'บันทึกการผ่อนชำระ') +
        hiddenField('debtId', existing ? existing.debtId : debtId) +
        (existing ? hiddenField('id', existing.id) : '') +
        dateField('วันที่ชำระ', 'date', existing ? existing.date.slice(0,10) : todayISO()) +
        numberField('เงินต้น', 'principal', { value: existing ? existing.principal : '' }) +
        numberField('ดอกเบี้ย', 'interest', { value: existing ? existing.interest : '' }) +
        textField('โน้ต (ไม่บังคับ)', 'note', { value: existing ? (existing.note || '') : '' }) +
        modalActions(existing ? deleteBtn('delete-payment', existing.id) : null) +
      '</form>';
  }

  function budgetModal(category) {
    var existing = Object.values(state.budgets).find(function(x){ return x.categoryId === category.id; });
    return '' +
      '<form id="budgetForm" class="modal-form">' +
        modalHeader('งบประมาณ · ' + escapeHtml(category.name)) +
        hiddenField('categoryId', category.id) +
        (existing ? hiddenField('id', existing.id) : '') +
        numberField('วงเงินต่อเดือน', 'amount', { value: existing ? existing.amount : '' }) +
        modalActions(existing ? deleteBtn('delete-budget', existing.id, 'ลบงบ') : null) +
      '</form>';
  }

  function recurringModal(existing) {
    existing = existing || {};
    var type = existing.type || 'expense';
    return '' +
      '<form id="recurringForm" class="modal-form">' +
        modalHeader(existing.id ? 'แก้ไขรายการที่เกิดซ้ำ' : 'เพิ่มรายการที่เกิดซ้ำ') +
        typeToggle('rec-type', incomeExpenseToggle, type) +
        hiddenField('type', type) +
        (existing.id ? hiddenField('id', existing.id) : '') +
        textField('ชื่อรายการ', 'note', { value: existing.note || '', required: true, placeholder: 'เช่น ค่าเช่าบ้าน, Netflix' }) +
        numberField('จำนวนเงิน', 'amount', { value: existing.amount != null ? existing.amount : '' }) +
        selectField('บัญชี', 'accountId', accountOptions(existing.accountId)) +
        selectField('หมวดหมู่', 'categoryId', categoryOptionsByType(type, existing.categoryId)) +
        dateField('วันที่ครั้งถัดไป', 'nextDate', existing.nextDate ? existing.nextDate.slice(0,10) : todayISO()) +
        modalActions(existing.id ? deleteBtn('delete-recurring', existing.id) : null) +
      '</form>';
  }

  function holdingModal(existing) {
    existing = existing || null;
    return '' +
      '<form id="holdingForm" class="modal-form">' +
        modalHeader(existing ? 'แก้ไขสินทรัพย์' : 'เพิ่มสินทรัพย์ลงทุน') +
        (existing ? hiddenField('id', existing.id) : '') +
        textField('ชื่อสินทรัพย์', 'name', { value: existing ? existing.name : '', required: true, placeholder: 'เช่น SET50, BTC, ทองคำแท่ง' }) +
        selectField('ประเภท', 'assetType', labelOptions(assetTypeLabels, existing && existing.assetType), true) +
        textField('หน่วยนับ (ไม่บังคับ)', 'unit', { value: existing ? (existing.unit || '') : '', placeholder: 'เช่น หุ้น, เหรียญ, บาททองคำ' }) +
        modalActions(existing ? deleteBtn('delete-holding', existing.id) : null) +
      '</form>';
  }

  var investActionToggle = [
    { type: 'buy', label: 'ซื้อ' },
    { type: 'sell', label: 'ขาย' },
    { type: 'dividend', label: 'ปันผล' }
  ];

  function investTxFields(action, existing) {
    existing = existing || {};
    if (action === 'dividend') {
      return numberField('จำนวนเงินปันผลที่ได้รับ', 'amount', { value: existing.amount != null ? existing.amount : '' });
    }
    return numberField('จำนวนหน่วย', 'qty', { value: existing.qty != null ? existing.qty : '' }) +
      numberField('ราคาต่อหน่วย', 'pricePerUnit', { value: existing.pricePerUnit != null ? existing.pricePerUnit : '' }) +
      numberField('ค่าธรรมเนียม (ไม่บังคับ)', 'fee', { value: existing.fee != null ? existing.fee : '', required: false, placeholder: '0' });
  }

  function investTxModal(holdingId, existing) {
    existing = existing || {};
    holdingId = holdingId || existing.holdingId;
    var action = existing.action || 'buy';
    var holding = state.holdings[holdingId];
    return '' +
      '<form id="investTxForm" class="modal-form">' +
        modalHeader((holding ? escapeHtml(holding.name) + ' · ' : '') + 'บันทึกธุรกรรมลงทุน') +
        typeToggle('invest-tx-type', investActionToggle, action) +
        hiddenField('action', action) +
        hiddenField('holdingId', holdingId) +
        (existing.id ? hiddenField('id', existing.id) : '') +
        investTxFields(action, existing) +
        selectField('บัญชีที่ใช้จ่าย/รับเงิน', 'accountId', accountOptions(existing.accountId)) +
        dateField('วันที่', 'date', existing.date ? existing.date.slice(0,10) : todayISO()) +
        textField('โน้ต (ไม่บังคับ)', 'note', { value: existing.note || '' }) +
        modalActions(null) +
      '</form>';
  }

  function updatePriceModal(holding) {
    return '' +
      '<form id="priceForm" class="modal-form">' +
        modalHeader('อัปเดตราคา · ' + escapeHtml(holding.name)) +
        hiddenField('holdingId', holding.id) +
        numberField('ราคาต่อหน่วยล่าสุด', 'lastPrice', { value: holding.lastPrice != null ? holding.lastPrice : '' }) +
        dateField('ณ วันที่', 'lastPriceDate', holding.lastPriceDate ? holding.lastPriceDate.slice(0,10) : todayISO()) +
        modalActions(null) +
      '</form>';
  }

  function investTxDetailModal(invTx) {
    var holding = state.holdings[invTx.holdingId];
    var actionLabel = {buy:'ซื้อ', sell:'ขาย', dividend:'ปันผล'}[invTx.action] || '';
    var rows = '';
    if (invTx.qty != null) rows += fieldDisplay('จำนวนหน่วย', fmtQty(invTx.qty));
    if (invTx.pricePerUnit != null) rows += fieldDisplay('ราคาต่อหน่วย', fmtInvMoney(invTx.pricePerUnit));
    if (invTx.fee) rows += fieldDisplay('ค่าธรรมเนียม', fmtMoney(invTx.fee));
    rows += fieldDisplay('บัญชี', escapeHtml((state.accounts[invTx.accountId] || {}).name || '-'));
    rows += fieldDisplay('จำนวนเงินรวม', fmtInvMoney(invTx.amount));
    if (invTx.note) rows += fieldDisplay('โน้ต', escapeHtml(invTx.note));
    return '<div class="modal-form">' +
      modalHeader((holding ? escapeHtml(holding.name) + ' · ' : '') + actionLabel) +
      rows +
      '<div class="tax-note">ลบรายการนี้จะคืนจำนวนหน่วย/เงินสดที่เกี่ยวข้องด้วยทันที (จำนวนหน่วยและต้นทุนเฉลี่ยคำนวณสดจากประวัติธุรกรรมทั้งหมดเสมอ ไม่มีการ cache ค่า จึงแม่นยำ 100% ไม่ต้องกังวลเรื่องค่าประมาณเหมือนเดิม)</div>' +
      '<div class="modal-actions">' + deleteBtn('delete-invest-tx', invTx.id) + '<span></span></div>' +
    '</div>';
  }

  // ---------- form handlers ----------
  function saveTransaction(fd) {
    var data = { type: fd.type, amount: requirePositive(fd.amount, 'จำนวนเงิน'), accountId: fd.accountId, categoryId: fd.categoryId, date: fd.date, note: fd.note || '' };
    return fd.id ? Store.update('transactions', fd.id, data) : Store.add('transactions', data);
  }
  function saveTransfer(fd) {
    if (fd.fromAccountId === fd.toAccountId) return Promise.reject(new Error('บัญชีต้นทางและปลายทางต้องไม่ใช่บัญชีเดียวกัน'));
    var data = { type: 'transfer', amount: requirePositive(fd.amount, 'จำนวนเงิน'), fromAccountId: fd.fromAccountId, toAccountId: fd.toAccountId, date: fd.date, note: fd.note || '' };
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
  function confirmDeleteTx(id) {
    if (confirm('ลบรายการนี้ใช่หรือไม่')) { Store.remove('transactions', id); closeModal(); }
  }
  function confirmDeleteAccount(id) {
    var hasTx = Object.values(state.transactions).some(function(t){
      if (t.type === 'transfer') return t.fromAccountId === id || t.toAccountId === id;
      return t.accountId === id;
    });
    if (hasTx) { alert('ไม่สามารถลบบัญชีที่มีรายการอยู่ได้ (รวมถึงรายการโอนเงิน/ธุรกรรมลงทุน) กรุณาลบหรือย้ายรายการก่อน'); return; }
    var hasRecurring = Object.values(state.recurringTemplates).some(function(r){ return r.accountId === id; });
    if (hasRecurring) { alert('ไม่สามารถลบบัญชีที่มีรายการเกิดซ้ำ (เช่น ค่าเช่า, ค่าบริการรายเดือน) ผูกอยู่ได้ กรุณาลบหรือย้ายรายการเกิดซ้ำก่อน'); return; }
    if (confirm('ลบบัญชีนี้ใช่หรือไม่')) { Store.remove('accounts', id); closeModal(); }
  }
  function confirmDeleteCategory(id) {
    var hasTx = Object.values(state.transactions).some(function(t){ return t.categoryId===id; });
    if (hasTx) { alert('ไม่สามารถลบหมวดหมู่ที่มีรายการอยู่ได้'); return; }
    if (confirm('ลบหมวดหมู่นี้ใช่หรือไม่')) { Store.remove('categories', id); }
  }

  // ---------- การลงทุน: form handlers ----------
  function saveHolding(fd) {
    var data = { name: fd.name, assetType: fd.assetType, unit: fd.unit || '' };
    return fd.id ? Store.update('holdings', fd.id, data) : Store.add('holdings', data);
  }
  function confirmDeleteHolding(id) {
    var hasTxns = investTxnsForHolding(id).length > 0;
    var msg = hasTxns
      ? 'สินทรัพย์นี้มีประวัติธุรกรรมอยู่ — ลบสินทรัพย์นี้แล้วประวัติธุรกรรม/รายการที่เกี่ยวข้องจะยังอยู่ (ไม่ถูกลบ) ต้องการลบสินทรัพย์นี้ใช่หรือไม่'
      : 'ลบสินทรัพย์นี้ใช่หรือไม่';
    if (confirm(msg)) { Store.remove('holdings', id); closeModal(); }
  }

  function saveInvestTx(fd) {
    var holdingId = fd.holdingId;
    var action = fd.action;
    var accountId = fd.accountId;
    var date = fd.date;
    var note = fd.note || '';
    var invData = { holdingId: holdingId, action: action, date: date, accountId: accountId, note: note };
    var amount;
    if (action === 'dividend') {
      amount = requirePositive(fd.amount, 'จำนวนเงินปันผล');
      invData.amount = amount;
      invData.qty = null; invData.pricePerUnit = null; invData.fee = null;
    } else {
      var qty = requirePositive(fd.qty, 'จำนวนหน่วย');
      var pricePerUnit = requirePositive(fd.pricePerUnit, 'ราคาต่อหน่วย');
      var fee = fd.fee ? requirePositive(fd.fee, 'ค่าธรรมเนียม') : 0;
      if (action === 'sell') {
        var ownedQty = holdingComputed(holdingId).qty;
        // ถ้าเป็นการแก้ไขรายการขายเดิม ต้องคืนจำนวนเดิมก่อนเช็ค กันเช็คผิดตอนแก้ไขรายการขายของตัวเอง
        if (fd.id && state.investmentTxns[fd.id] && state.investmentTxns[fd.id].action === 'sell') {
          ownedQty += Number(state.investmentTxns[fd.id].qty || 0);
        }
        if (qty > ownedQty + 1e-9) throw new Error('จำนวนหน่วยที่ขายมากกว่าที่ถืออยู่ (มี ' + fmtQty(ownedQty) + ')');
      }
      amount = action === 'buy' ? (qty * pricePerUnit + fee) : Math.max(0, qty * pricePerUnit - fee);
      invData.qty = qty; invData.pricePerUnit = pricePerUnit; invData.fee = fee; invData.amount = amount;
    }

    var txnPatch = { type: 'investment', investAction: action, accountId: accountId, amount: amount, date: date, note: note, holdingId: holdingId };

    if (fd.id) {
      var linkedTxnId = state.investmentTxns[fd.id] && state.investmentTxns[fd.id].txnId;
      return Store.update('investmentTxns', fd.id, invData).then(function(){
        if (linkedTxnId) {
          txnPatch.invTxnId = fd.id;
          return Store.update('transactions', linkedTxnId, txnPatch);
        }
      });
    }
    return Store.add('investmentTxns', invData).then(function(invId){
      txnPatch.invTxnId = invId;
      return Store.add('transactions', txnPatch).then(function(txnId){
        return Store.update('investmentTxns', invId, { txnId: txnId });
      });
    });
  }
  function confirmDeleteInvestTx(id) {
    if (!confirm('ลบรายการนี้ใช่หรือไม่')) return;
    var invTx = state.investmentTxns[id];
    if (invTx && invTx.txnId) Store.remove('transactions', invTx.txnId);
    Store.remove('investmentTxns', id);
    closeModal();
  }
  function handleInvTxTypeSwitch(newType) {
    var form = document.getElementById('investTxForm');
    var fd = Object.fromEntries(new FormData(form).entries());
    openModal(investTxModal(fd.holdingId, { id: fd.id, action: newType, accountId: fd.accountId, date: fd.date, note: fd.note }));
  }

  function savePrice(fd) {
    var data = { lastPrice: requirePositive(fd.lastPrice, 'ราคา'), lastPriceDate: fd.lastPriceDate };
    return Store.update('holdings', fd.holdingId, data);
  }
  // คิวสำหรับปุ่ม "อัปเดตราคาทั้งหมด" — ไล่เปิดโมดัลราคาทีละ holding ให้กรอกรวดเดียว
  var priceUpdateQueue = [];
  function openSinglePriceUpdate(id) {
    priceUpdateQueue = [];
    var h = state.holdings[id];
    if (h) openModal(updatePriceModal(h));
  }
  function startPriceUpdateAll() {
    priceUpdateQueue = Object.keys(state.holdings);
    if (!priceUpdateQueue.length) { showToast('ยังไม่มีสินทรัพย์ให้อัปเดตราคา', 'error'); return; }
    openNextPriceUpdate();
  }
  function openNextPriceUpdate() {
    if (!priceUpdateQueue.length) { closeModal(); showToast('อัปเดตราคาครบทุกรายการแล้ว', 'success'); return; }
    var id = priceUpdateQueue.shift();
    var h = state.holdings[id];
    if (!h) { openNextPriceUpdate(); return; }
    openModal(updatePriceModal(h));
  }

  function saveDebt(fd) {
    var data = { name: fd.name, principal: requirePositive(fd.principal, 'ยอดกู้'), startDate: fd.startDate || '', note: fd.note || '' };
    return fd.id ? Store.update('debts', fd.id, data) : Store.add('debts', data);
  }
  function savePayment(fd) {
    var data = { debtId: fd.debtId, date: fd.date, principal: requirePositive(fd.principal, 'เงินต้น'), interest: requirePositive(fd.interest, 'ดอกเบี้ย'), note: fd.note || '' };
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
    var data = { categoryId: fd.categoryId, amount: requirePositive(fd.amount, 'วงเงิน') };
    return fd.id ? Store.update('budgets', fd.id, data) : Store.add('budgets', data);
  }
  function confirmDeleteBudget(id) {
    if (confirm('ลบงบประมาณนี้ใช่หรือไม่')) { Store.remove('budgets', id); closeModal(); }
  }

  function saveRecurring(fd) {
    var data = { type: fd.type, note: fd.note, amount: requirePositive(fd.amount, 'จำนวนเงิน'), accountId: fd.accountId, categoryId: fd.categoryId, nextDate: fd.nextDate, dayOfMonth: new Date(fd.nextDate).getDate(), active: true };
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
  function handleFabAdd() {
    if (!allReady()) return;
    if (currentTab === 'debts') {
      if (isCreditDebtId(selectedDebtId)) {
        // บัตรเครดิตคำนวณยอดหนี้สดจากบัญชี ไม่มีฟอร์มบันทึกการผ่อนชำระให้ใช้ — กันไม่ให้สร้าง debtPayments ที่ผูกกับ debtId ปลอม
        alert('บัตรเครดิตคำนวณยอดหนี้สดจากรายการโอนเงิน ไม่ต้องบันทึกการผ่อนชำระแยก ใช้ปุ่ม "⇄ โอนเงินระหว่างบัญชี" ในแท็บ "รายการ" แทน');
        return;
      }
      if (selectedDebtId && state.debts[selectedDebtId]) openModal(paymentModal(null, selectedDebtId));
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
      if (t.type === 'transfer') {
        var fromName = (state.accounts[t.fromAccountId]&&state.accounts[t.fromAccountId].name)||'';
        var toName = (state.accounts[t.toAccountId]&&state.accounts[t.toAccountId].name)||'';
        rows.push([ t.date, 'โอนเงิน', fromName + ' → ' + toName, '', t.amount, t.note||'' ]);
        return;
      }
      if (t.type === 'investment') {
        var holdingName = (state.holdings[t.holdingId] && state.holdings[t.holdingId].name) || '';
        var invAccName = (state.accounts[t.accountId] && state.accounts[t.accountId].name) || '';
        var invActionLabel = {buy:'ซื้อ', sell:'ขาย', dividend:'ปันผล'}[t.investAction] || '';
        rows.push([ t.date, 'ลงทุน:' + invActionLabel, invAccName, holdingName, t.amount, t.note||'' ]);
        return;
      }
      rows.push([ t.date, t.type==='income'?'รายรับ':'รายจ่าย',
        (state.accounts[t.accountId]&&state.accounts[t.accountId].name)||'',
        (state.categories[t.categoryId]&&state.categories[t.categoryId].name)||'',
        t.amount, t.note||'' ]);
    });
    var csv = rows.map(function(r){ return r.map(csvEscape).join(','); }).join('\r\n');
    var blob = new Blob(["﻿" + csv], { type: 'text/csv;charset=utf-8;' });
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
      case 'edit-tx':
        var txItem = state.transactions[id];
        if (txItem && txItem.type === 'transfer') openModal(transferModal(txItem));
        else openModal(transactionModal(txItem));
        break;
      case 'delete-tx': confirmDeleteTx(id); break;
      case 'tx-type': handleTxTypeSwitch(el.dataset.type); break;
      case 'add-transfer': openModal(transferModal(null)); break;
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
      case 'add-holding': openModal(holdingModal(null)); break;
      case 'edit-holding': openModal(holdingModal(state.holdings[id])); break;
      case 'delete-holding': confirmDeleteHolding(id); break;
      case 'add-invest-tx': openModal(investTxModal(id, null)); break;
      case 'invest-tx-type': handleInvTxTypeSwitch(el.dataset.type); break;
      case 'update-price': openSinglePriceUpdate(id); break;
      case 'update-all-prices': startPriceUpdateAll(); break;
      case 'view-invest-tx':
        var invTx = state.investmentTxns[id];
        if (invTx) openModal(investTxDetailModal(invTx));
        break;
      case 'delete-invest-tx': confirmDeleteInvestTx(id); break;
    }
  });

  document.getElementById('fabBtn').addEventListener('click', handleFabAdd);
  if (sideFabBtnEl) sideFabBtnEl.addEventListener('click', handleFabAdd);

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
    try {
      var action;
      if (form.id === 'txForm') action = saveTransaction(fd);
      else if (form.id === 'transferForm') action = saveTransfer(fd);
      else if (form.id === 'accountForm') action = saveAccount(fd);
      else if (form.id === 'categoryForm') action = saveCategory(fd);
      else if (form.id === 'debtForm') action = saveDebt(fd);
      else if (form.id === 'paymentForm') action = savePayment(fd);
      else if (form.id === 'budgetForm') action = saveBudget(fd);
      else if (form.id === 'recurringForm') action = saveRecurring(fd);
      else if (form.id === 'holdingForm') action = saveHolding(fd);
      else if (form.id === 'investTxForm') action = saveInvestTx(fd);
      else if (form.id === 'priceForm') action = savePrice(fd);
      else return;
      Promise.resolve(action).then(function(){
        if (form.id === 'priceForm') {
          // ปุ่ม "อัปเดตราคาทั้งหมด" ไล่เปิดโมดัลถัดไปในคิวต่อทันทีแทนที่จะปิดโมดัล
          showToast('อัปเดตราคาแล้ว', 'success');
          if (priceUpdateQueue.length) openNextPriceUpdate(); else closeModal();
          return;
        }
        closeModal();
        showToast('บันทึกสำเร็จ', 'success');
      }).catch(function(err){
        showToast('บันทึกไม่สำเร็จ: ' + (err && err.message ? err.message : err), 'error');
      });
    } catch (err) {
      showToast('บันทึกไม่สำเร็จ: ' + (err && err.message ? err.message : err), 'error');
    }
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
