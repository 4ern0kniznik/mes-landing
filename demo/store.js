/* Демо-стор: отдаёт те же ответы, что и REST API MES, но из выгрузки реального
   прогона решателя (data.js) и держит изменения в памяти вкладки.
   Состояние живёт в верхнем окне, поэтому пульт мастера и терминал видят
   действия друг друга. */
(function () {
  'use strict';

  function rootWindow() {
    try {
      if (window.top && window.top.__MES_DEMO_ROOT) return window.top.__MES_DEMO_ROOT;
    } catch (e) { /* другой origin — работаем локально */ }
    return window;
  }

  function sourceData() {
    if (window.MES_DEMO) return window.MES_DEMO;
    try { if (window.top && window.top.MES_DEMO) return window.top.MES_DEMO; } catch (e) {}
    throw new Error('data.js не загружен');
  }

  function buildState() {
    var src = JSON.parse(JSON.stringify(sourceData()));
    var byId = {};
    Object.keys(src.queues).forEach(function (code) {
      src.queues[code].queue.forEach(function (op) {
        op.work_center = code;
        byId[op.operation_id] = op;
      });
    });
    return {
      data: src,
      byId: byId,
      nextDowntimeId: 1000,
      downtimeStarted: {}
    };
  }

  var root = rootWindow();
  if (!root.__MES_DEMO_STATE) root.__MES_DEMO_STATE = buildState();
  var S = root.__MES_DEMO_STATE;

  function ganttRow(op) {
    return S.data.gantt.rows.find(function (r) {
      return r.order === op.order && r.op === op.operation && r.wc === op.work_center;
    });
  }

  function requireOp(id) {
    var op = S.byId[id];
    if (!op) throw new Error('Операция не найдена');
    return op;
  }

  function reply(value) {
    // небольшая задержка, чтобы демо вело себя как настоящая сеть
    return new Promise(function (resolve) {
      setTimeout(function () { resolve(JSON.parse(JSON.stringify(value))); }, 90);
    });
  }

  function queueOf(code) {
    var q = S.data.queues[code];
    if (!q) throw new Error('Рабочий центр не найден: ' + code);
    return {
      work_center: code,
      downtime: q.downtime || null,
      queue: q.queue.filter(function (op) { return op.status !== 'done'; })
    };
  }

  function recountWip() {
    var wip = { planned: 0, in_progress: 0, done: 0 };
    S.data.gantt.rows.forEach(function (r) {
      if (wip[r.status] !== undefined) wip[r.status] += 1;
    });
    S.data.wip = wip;
    return wip;
  }

  function handle(path, options) {
    var method = (options && options.method) || 'GET';
    var body = options && options.body ? JSON.parse(options.body) : {};
    var url = path.split('?')[0];

    if (method === 'GET') {
      if (url === '/api/plan/gantt-data') return reply(S.data.gantt);
      if (url === '/api/reports/load') return reply(S.data.load);
      if (url === '/api/reports/oee') return reply(S.data.oee);
      if (url === '/api/reports/wip') return reply(recountWip());
      if (url === '/api/reference/work-centers') return reply(S.data.work_centers);
      if (url === '/api/terminal/downtime-reasons') return reply(S.data.downtime_reasons);
      if (url.indexOf('/api/terminal/queue/') === 0) {
        return reply(queueOf(decodeURIComponent(url.slice('/api/terminal/queue/'.length))));
      }
      // В демо терминал открыт от имени оператора: так панель смены сразу заполнена.
      if (url === '/api/auth/me') {
        var first = (S.data.operators || [])[0];
        return reply(first
          ? { login: first.login, role: 'operator', full_name: first.full_name }
          : { login: 'demo', role: 'master', full_name: 'Демо-мастер' });
      }
      if (url === '/api/reference/operators') return reply(S.data.operators || []);
    }

    if (method === 'POST') {
      if (url === '/api/plan/replan') {
        // Демо не считает CP-SAT в браузере: показываем сводку того же прогона,
        // что лежит в data.js, и честно ничего не пересчитываем.
        var meta = S.data.meta.solve;
        var running = S.data.gantt.rows.filter(function (r) { return r.status === 'in_progress'; }).length;
        var planned = S.data.gantt.rows.filter(function (r) { return r.status === 'planned'; });
        var shifts = planned.slice(0, 5).map(function (r, i) {
          return { operation_id: i + 1, order: r.order, operation: r.op, work_center: r.wc,
                   shift_minutes: [96, 241, 292, 292, 577][i % 5] };
        });
        return reply({
          status: meta.status,
          solve_seconds: meta.solve_seconds,
          operations: meta.operations,
          pinned: running,
          unchanged: Math.max(0, planned.length - shifts.length * 4),
          moved_later: shifts.length * 2,
          moved_earlier: shifts.length * 2,
          new_in_plan: 0,
          max_shift_minutes: 577,
          avg_shift_minutes: 128.4,
          center_changed: [],
          center_changed_total: 0,
          makespan_hours: meta.makespan_hours,
          total_setup_minutes: meta.total_setup_minutes,
          late_before: meta.late_orders || [],
          late_after: meta.late_orders || [],
          newly_late: [],
          recovered: [],
          top_shifts: shifts,
          threshold_minutes: 15,
          applied: body.apply ? meta.operations - running : 0
        });
      }
      if (url === '/api/plan/solve') {
        var solve = S.data.meta.solve;
        var pinned = S.data.gantt.rows.filter(function (r) { return r.status === 'in_progress'; }).length;
        return reply({
          status: solve.status,
          solve_seconds: solve.solve_seconds,
          operations: solve.operations,
          applied: solve.operations - pinned,
          makespan_hours: solve.makespan_hours,
          total_setup_minutes: solve.total_setup_minutes,
          total_tardiness_hours: solve.total_tardiness_hours,
          late_orders: solve.late_orders,
          demo_pinned: pinned
        });
      }
      if (url === '/api/terminal/start') {
        var op = requireOp(body.operation_id);
        if (op.status === 'in_progress') throw new Error('Операция уже в работе');
        // Смена: те же проверки, что и на сервере, — демо не должно быть добрее системы.
        if (body.operator_login) {
          var known = (S.data.operators || []).some(function (o) { return o.login === body.operator_login; });
          if (!known) throw new Error("Оператор с логином '" + body.operator_login + "' не найден в справочнике пользователей");
          op.operator = body.operator_login;
        }
        if (body.post_index) {
          var wcRow = (S.data.work_centers || []).filter(function (w) { return w.code === op.work_center; })[0];
          var capacity = wcRow ? wcRow.capacity : 1;
          if (body.post_index < 1 || body.post_index > capacity) {
            throw new Error('Пост ' + body.post_index + ' не существует: на центре ' + op.work_center +
                            ' постов ' + capacity + ', допустимо от 1 до ' + capacity);
          }
          op.post_index = body.post_index;
        }
        if (body.material_lot) op.material_lot = body.material_lot;
        op.status = 'in_progress';
        var row = ganttRow(op);
        if (row) row.status = 'in_progress';
        recountWip();
        return reply({
          status: 'ok',
          operation_id: op.operation_id,
          operator: op.operator || null,
          post_index: op.post_index || null,
          material_lot: op.material_lot || ''
        });
      }
      if (url === '/api/terminal/finish') {
        var fop = requireOp(body.operation_id);
        if (fop.status !== 'in_progress') throw new Error('Операция не запущена');
        var good = Number(body.qty_good), scrap = Number(body.qty_scrap);
        if (!isFinite(good) || good < 0 || !isFinite(scrap) || scrap < 0) {
          throw new Error('Количество не может быть отрицательным');
        }
        if (good + scrap === 0) throw new Error('Укажите годные или брак');
        fop.status = 'done';
        fop.qty_good = good;
        fop.qty_scrap = scrap;
        var frow = ganttRow(fop);
        if (frow) frow.status = 'done';
        recountWip();
        return reply({ status: 'ok', qty_good: good, qty_scrap: scrap });
      }
      if (url === '/api/terminal/downtime') {
        var code = body.work_center_code;
        if (!S.data.queues[code]) throw new Error('Рабочий центр не найден: ' + code);
        var id = S.nextDowntimeId++;
        var startedAt = new Date().toISOString().slice(0, 19);
        S.data.queues[code].downtime = { id: id, reason: body.reason, started_at: startedAt };
        S.downtimeStarted[id] = Date.now();
        return reply({ id: id, reason: body.reason, started_at: startedAt });
      }
      var m = url.match(/^\/api\/terminal\/downtime\/(\d+)\/close$/);
      if (m) {
        var did = Number(m[1]);
        var closed = false, minutes = 0;
        Object.keys(S.data.queues).forEach(function (c) {
          var d = S.data.queues[c].downtime;
          if (d && d.id === did) {
            minutes = Math.max(1, Math.round((Date.now() - (S.downtimeStarted[did] || Date.now())) / 60000));
            S.data.queues[c].downtime = null;
            closed = true;
          }
        });
        if (!closed) throw new Error('Простой не найден');
        return reply({ id: did, minutes: minutes });
      }
    }

    throw new Error('В демо этот вызов не поддержан: ' + method + ' ' + path);
  }

  window.MES_DEMO_API = function (path, options) {
    try {
      return handle(path, options);
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  };

  window.MES_DEMO_RESET = function () {
    var fresh = buildState();
    S.data = fresh.data;
    S.byId = fresh.byId;
    S.nextDowntimeId = fresh.nextDowntimeId;
    S.downtimeStarted = {};
  };
})();
