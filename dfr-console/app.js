/* ==========================================================================
   DFR Handover Console — app.js
   --------------------------------------------------------------------------
   Sections
     0. Utilities
     1. State machine: incident states, oversight modes, control, audit log
        (pure: no DOM, no wall-clock time; deterministic per tick)
     2. Selectors: derived values read by the renderer
     3. Playback controller
     4. Rendering
     5. Input: clicks and keyboard
     6. Boot
   ========================================================================== */
(function () {
  'use strict';

  /* ========================================================================
     0. UTILITIES
     ======================================================================== */

  var TPS = 10;                       // simulation ticks per scenario second

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
  function toTicks(s) { return Math.round(s * TPS); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function fmtMS(sec) {
    if (sec == null || isNaN(sec)) return '–:––';
    var neg = sec < 0; sec = Math.abs(Math.floor(sec));
    return (neg ? '−' : '') + Math.floor(sec / 60) + ':' + pad2(sec % 60);
  }
  function parseClock(str) {
    var p = str.split(':').map(Number);
    return p[0] * 3600 + p[1] * 60 + (p[2] || 0);
  }
  function fmtClock(sec) {
    sec = ((Math.floor(sec) % 86400) + 86400) % 86400;
    return pad2(Math.floor(sec / 3600)) + ':' + pad2(Math.floor(sec / 60) % 60) + ':' + pad2(sec % 60);
  }
  function confWord(c) { return c >= 0.8 ? 'High' : c >= 0.5 ? 'Medium' : 'Low'; }
  function fmtConf(c, verifiedBy) {
    if (c == null) return 'Confirmed · ' + (verifiedBy || 'human');
    return confWord(c) + ' · ' + c.toFixed(2);
  }
  function esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function polyLength(pts) {
    var L = 0;
    for (var i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    return L;
  }
  function pointAlong(pts, f) {
    var total = polyLength(pts), d = clamp(f, 0, 1) * total;
    for (var i = 1; i < pts.length; i++) {
      var a = pts[i - 1], b = pts[i], seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (d <= seg || i === pts.length - 1) {
        var k = seg ? clamp(d / seg, 0, 1) : 0;
        return { x: lerp(a[0], b[0], k), y: lerp(a[1], b[1], k), heading: Math.atan2(b[1] - a[1], b[0] - a[0]) };
      }
      d -= seg;
    }
    return { x: pts[0][0], y: pts[0][1], heading: 0 };
  }
  function polyBBox(pts) {
    var b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    pts.forEach(function (p) {
      b.x0 = Math.min(b.x0, p[0]); b.y0 = Math.min(b.y0, p[1]);
      b.x1 = Math.max(b.x1, p[0]); b.y1 = Math.max(b.y1, p[1]);
    });
    return b;
  }

  /* ========================================================================
     1. STATE MACHINE
     ------------------------------------------------------------------------
     Incident states
       IDLE ─START→ INCIDENT_IN ─launch_gate→ LAUNCH_GATE ─launch→ TRANSIT
            ─arrive→ HANDOVER ─OP_TAKE_CONTROL→ ON_SCENE ─OP_END→ RTB ─docked→ CLOSED
       LAUNCH_GATE ─OP_DECLINE_LAUNCH / OP_ABORT_LAUNCH→ PATROL_ONLY ─OP_END→ CLOSED

     Orthogonal state: mode, controller (SYSTEM | OPERATOR), recording,
     camera, garden decision, feed sharing, POIs, detections, unknowns.

     Every change goes through dispatch() (operator actions) or fire()
     (scripted system events), and every one of them writes to the audit log.
     ======================================================================== */

  var MODES = {
    INTERACTIVE: { label: 'Interactive', summary: 'The system recommends a launch and gives its reasons. You approve it.' },
    SUPERVISED: { label: 'Supervised', summary: 'The system launches on its own. You get 10 seconds to abort.' },
    LIGHTS_OUT: { label: 'Lights-out', summary: 'The system launches on its own and tells you afterwards.' }
  };

  var Model = (function () {

    function create(sc, mode) {
      var dock = sc.drone.dock;
      return {
        sc: sc,
        mode: mode,
        status: 'IDLE',
        tick: 0,
        controller: 'SYSTEM',
        recording: false,
        airborne: false,
        anchors: { T: null, G: null, L: null, A: null, H: null, C: null, P: null, E: null, D: null },
        gateDeadline: null,
        launchDecision: null,         // { how, tick }
        drone: {
          x: dock[0], y: dock[1], alt: 0, speed: 0, heading: 0,
          battery: sc.drone.batteryStart, link: sc.drone.linkStart,
          phase: 'DOCKED', orbitAngle: 0
        },
        orbiting: true,
        rtbRoute: null,
        camAuto: null,                // { mode: 'SITE', tick }
        camera: { target: null, zoom: 1 },
        garden: { choice: 'PENDING', history: [] },
        feedShared: false,
        pois: [],
        detections: {}, detOrder: [],
        unknowns: {}, unkOrder: [],
        suggestionsUsed: {},
        fired: {},
        audit: [],
        metrics: { privateRecTicks: 0 },
        rev: 0
      };
    }

    /* ---- audit log ---------------------------------------------------- */
    function log(s, actor, action, reason, opts) {
      opts = opts || {};
      s.audit.push({
        n: s.audit.length + 1,
        tick: s.tick,
        actor: actor,
        action: action,
        reason: reason || '',
        rule: opts.rule || null,
        brief: !!opts.brief
      });
      s.rev++;
    }

    /* ---- scripted events ---------------------------------------------- */
    function resolveAnchor(s, anchor) {
      if (Array.isArray(anchor)) {
        var m = -Infinity;
        for (var i = 0; i < anchor.length; i++) {
          var v = s.anchors[anchor[i]];
          if (v == null) return null;
          m = Math.max(m, v);
        }
        return m;
      }
      var a = s.anchors[anchor];
      return a == null ? null : a;
    }
    function keyTick(s, k) {
      var a = resolveAnchor(s, k.anchor);
      return a == null ? null : a + toTicks(k.at);
    }
    function matches(s, when) {
      if (!when) return true;
      if (when.garden) {
        var g = Array.isArray(when.garden) ? when.garden : [when.garden];
        if (g.indexOf(s.garden.choice) < 0) return false;
      }
      if (when.status && when.status.indexOf(s.status) < 0) return false;
      if (when.detected && !s.detections[when.detected]) return false;
      return true;
    }

    function runScript(s) {
      var evs = s.sc.events, again = true, guard = 0;
      while (again && guard++ < 5) {
        again = false;
        for (var i = 0; i < evs.length; i++) {
          if (s.fired[i]) continue;
          var t = keyTick(s, evs[i]);
          if (t == null || s.tick < t || !matches(s, evs[i].when)) continue;
          s.fired[i] = true;
          fire(s, evs[i]);
          again = true;
        }
      }
    }

    function fire(s, ev) {
      var sc = s.sc;
      switch (ev.type) {
        case 'policy_check':
          log(s, 'SYSTEM', 'Checked launch policy: launch is allowed', sc.launch.policySummary, { rule: sc.launch.rule });
          break;
        case 'launch_gate':
          if (s.status === 'INCIDENT_IN') openGate(s);
          break;
        case 'log':
          log(s, ev.actor || 'SYSTEM', ev.action, ev.reason, { rule: ev.rule, brief: ev.brief });
          break;
        case 'link':
          s.drone.link = ev.value;
          break;
        case 'camera_auto':
          s.camAuto = { mode: ev.mode, tick: s.tick };
          break;
        case 'unknown':
          s.unknowns[ev.id] = { id: ev.id, text: sc.unknowns[ev.id], tick: s.tick, note: null, resolved: false };
          s.unkOrder.push(ev.id);
          log(s, 'SYSTEM', 'Added unknown ' + ev.id + ' to the handover brief', sc.unknowns[ev.id]);
          break;
        case 'detect': {
          var d = sc.detections[ev.id];
          s.detections[ev.id] = {
            id: ev.id, entity: d.entity, kind: d.kind, label: d.label, size: d.size,
            confidence: d.confidence, evidence: d.evidence, tick: s.tick,
            needsHuman: !!d.needsHuman, privateArea: d.privateArea || null,
            status: d.needsHuman ? 'Needs your decision' : 'Detected', verifiedBy: null, version: 1
          };
          s.detOrder.push(ev.id);
          log(s, 'SYSTEM', 'Detected ' + ev.id + ': ' + d.label + ' (' + fmtConf(d.confidence) + ')', d.evidence,
            { rule: d.needsHuman ? 'DFR-P2' : null });
          break;
        }
        case 'detect_update': {
          var x = s.detections[ev.id];
          if (!x) break;
          if (ev.label) x.label = ev.label;
          if ('confidence' in ev) x.confidence = ev.confidence;
          if (ev.verifiedBy) x.verifiedBy = ev.verifiedBy;
          if (ev.evidence) x.evidence = ev.evidence;
          if (ev.status) x.status = ev.status;
          else if (ev.verifiedBy) x.status = 'Confirmed by ' + ev.verifiedBy;
          else x.status = 'Updated';
          x.needsHuman = false;
          x.version++;
          log(s, 'SYSTEM', 'Updated ' + ev.id + ': ' + x.label + ' (' + fmtConf(x.confidence, x.verifiedBy) + ')',
            ev.evidence || 'Patrol status update.');
          if (ev.resolve && s.unknowns[ev.resolve.id]) {
            s.unknowns[ev.resolve.id].resolved = true;
            s.unknowns[ev.resolve.id].note = ev.resolve.note;
          }
          break;
        }
        case 'arrive':
          if (s.status === 'TRANSIT') arrive(s);
          break;
        case 'patrol_on_scene':
          s.anchors.P = s.tick;
          log(s, 'SYSTEM', 'Patrol ' + sc.patrol.id + ' on scene at ' + sc.incident.address, 'Unit status update from ' + sc.patrol.id + '.');
          break;
        case 'docked':
          if (s.status === 'RTB') dock(s);
          break;
      }
    }

    /* ---- transitions -------------------------------------------------- */
    function openGate(s) {
      var sc = s.sc, rule = sc.launch.rule;
      s.status = 'LAUNCH_GATE';
      s.anchors.G = s.tick;
      if (s.mode === 'INTERACTIVE') {
        log(s, 'SYSTEM', 'Recommended launching ' + sc.drone.id + '; waiting for operator approval',
          'Interactive mode. Drone ETA ' + fmtMS(sc.incident.drone.etaS) + ' vs patrol ETA ' + fmtMS(sc.incident.patrol.etaS) + '; policy conditions met.', { rule: rule });
      } else if (s.mode === 'SUPERVISED') {
        s.gateDeadline = s.tick + toTicks(sc.launch.abortWindowS);
        log(s, 'SYSTEM', 'Armed automatic launch with a ' + sc.launch.abortWindowS + ' s abort window',
          'Supervised mode; policy conditions met.', { rule: rule });
      } else {
        launch(s, 'Lights-out mode; policy conditions met. No operator approval needed.', 'auto-lights-out');
        log(s, 'SYSTEM', 'Notified the operator of the launch', 'Lights-out mode informs the operator; it does not ask.');
      }
    }

    function launch(s, reason, how) {
      var sc = s.sc;
      s.anchors.L = s.tick;
      s.status = 'TRANSIT';
      s.launchDecision = { how: how, tick: s.tick };
      s.drone.phase = 'TRANSIT';
      s.airborne = true;
      log(s, 'SYSTEM', 'Launched ' + sc.drone.id + ' from ' + sc.incident.drone.dock, reason, { rule: sc.launch.rule, brief: true });
      s.recording = true;
      log(s, 'SYSTEM', 'Started recording', 'Recording runs from launch to dock.', { rule: 'DFR-R1', brief: true });
    }

    function toPatrolOnly(s, how, reason) {
      s.status = 'PATROL_ONLY';
      s.launchDecision = { how: how, tick: s.tick };
      log(s, 'SYSTEM', 'Kept ' + s.sc.drone.id + ' docked; incident continues with patrol only', reason);
    }

    function arrive(s) {
      var o = s.sc.drone.orbit;
      s.status = 'HANDOVER';
      s.anchors.A = s.tick;
      s.drone.phase = 'ORBIT';
      s.drone.orbitAngle = Math.atan2(s.drone.y - o.cy, s.drone.x - o.cx);
      log(s, 'SYSTEM', 'Arrived; holding an ' + (o.r * s.sc.map.metresPerUnit) + ' m orbit at ' + s.sc.drone.cruiseAltM + ' m',
        'Reached the incident address.', { brief: true });
      log(s, 'SYSTEM', 'Asked the operator to take control',
        'Handover point. The drone keeps orbiting until the operator takes control.', { rule: 'DFR-H1' });
    }

    function endIncident(s) {
      var sc = s.sc;
      s.anchors.E = s.tick;
      log(s, 'OPERATOR', 'Ended the incident', 'Patrol ' + sc.patrol.id + ' on scene' +
        (s.status === 'PATROL_ONLY' ? '; console role complete.' : '; aerial view no longer needed.'));
      if (s.status === 'PATROL_ONLY') {
        s.status = 'CLOSED';
        s.anchors.D = s.tick;
        log(s, 'SYSTEM', 'Closed the incident on the console', 'No drone was deployed.');
        return;
      }
      if (s.garden.choice === 'PENDING' && s.detections['D-02']) {
        log(s, 'SYSTEM', 'Closed the garden detection without an operator decision',
          'No choice was made before the incident ended.', { rule: 'DFR-P2' });
      }
      if (s.feedShared) {
        s.feedShared = false;
        log(s, 'SYSTEM', 'Stopped sharing the feed with ' + sc.patrol.id, 'Incident ended.');
      }
      s.controller = 'SYSTEM';
      s.status = 'RTB';
      s.drone.phase = 'RTB';
      s.camera = { target: null, zoom: 1 };
      s.camAuto = null;
      var r = sc.drone.route;
      s.rtbRoute = [[s.drone.x, s.drone.y]].concat(r.slice(0, r.length - 1).reverse());
      log(s, 'SYSTEM', 'Took back control from the operator', 'Incident ended; return to dock is autonomous.', { rule: 'DFR-H3' });
      log(s, 'SYSTEM', 'Returning to ' + sc.incident.drone.dock + ' on its own', 'Incident ended by the operator.', { rule: 'DFR-H3' });
    }

    function dock(s) {
      var sc = s.sc;
      s.status = 'CLOSED';
      s.anchors.D = s.tick;
      s.drone.phase = 'DOCKED';
      s.drone.alt = 0; s.drone.speed = 0;
      s.airborne = false;
      log(s, 'SYSTEM', 'Docked ' + sc.drone.id + ' at ' + sc.incident.drone.dock, 'Return complete.');
      if (s.recording) {
        s.recording = false;
        log(s, 'SYSTEM', 'Stopped recording', 'Drone docked.', { rule: 'DFR-R1' });
      }
      log(s, 'SYSTEM', 'Closed the incident on the console', 'Close-out summary ready.');
    }

    /* ---- operator actions --------------------------------------------- */
    function operatorHasControl(s) { return s.status === 'ON_SCENE' && s.controller === 'OPERATOR'; }

    function dispatch(s, a) {
      var sc = s.sc;
      switch (a.type) {
        case 'START':
          if (s.status !== 'IDLE') return false;
          s.status = 'INCIDENT_IN';
          s.anchors.T = 0;
          log(s, 'OPERATOR', 'Set oversight mode to ' + MODES[s.mode].label, 'Chosen before the incident; locked while it runs.');
          log(s, 'SYSTEM', 'Received incident ' + sc.incident.ref + ': ' + sc.incident.type,
            'Created upstream by call-taking. Caller: ' + sc.incident.caller + '.');
          log(s, 'SYSTEM', 'Assigned nearest drone ' + sc.drone.id + ' (' + sc.incident.drone.distanceKm + ' km)',
            'Nearest available dock to ' + sc.incident.address + '.');
          return true;

        case 'OP_APPROVE_LAUNCH':
          if (s.status !== 'LAUNCH_GATE' || s.mode !== 'INTERACTIVE') return false;
          log(s, 'OPERATOR', 'Approved launch', a.via === 'playback'
            ? 'Playback shortcut (jump to handover) approved on the operator\'s behalf.'
            : 'Accepted the system recommendation after ' + fmtMS((s.tick - s.anchors.G) / TPS) + '.');
          launch(s, 'Operator approved the launch.', a.via === 'playback' ? 'approved-playback' : 'approved');
          return true;

        case 'OP_DECLINE_LAUNCH':
          if (s.status !== 'LAUNCH_GATE' || s.mode !== 'INTERACTIVE') return false;
          log(s, 'OPERATOR', 'Declined launch', 'Overrode the system recommendation. Patrol ' + sc.patrol.id + ' continues.');
          toPatrolOnly(s, 'declined', 'Operator declined the launch.');
          return true;

        case 'OP_ABORT_LAUNCH':
          if (s.status !== 'LAUNCH_GATE' || s.mode !== 'SUPERVISED') return false;
          log(s, 'OPERATOR', 'Aborted automatic launch',
            'Inside the abort window, ' + ((s.gateDeadline - s.tick) / TPS).toFixed(1) + ' s before launch.');
          toPatrolOnly(s, 'aborted', 'Operator aborted the launch.');
          return true;

        case 'OP_TAKE_CONTROL':
          if (s.status !== 'HANDOVER') return false;
          s.anchors.H = s.tick;
          s.controller = 'OPERATOR';
          s.status = 'ON_SCENE';
          log(s, 'OPERATOR', 'Took control', 'Explicit take-control. Time-to-handover ' + fmtMS((s.anchors.H - s.anchors.A) / TPS) + '.');
          log(s, 'SYSTEM', 'Handed control to the operator', 'From now on, system suggestions wait for the operator.', { rule: 'DFR-H1' });
          return true;

        case 'OP_HOLD':
          if (!operatorHasControl(s) || !s.orbiting) return false;
          s.orbiting = false;
          s.drone.phase = 'HOLD';
          log(s, 'OPERATOR', 'Held position', a.reason || 'Operator stopped the orbit.');
          return true;

        case 'OP_ORBIT': {
          if (!operatorHasControl(s) || s.orbiting) return false;
          var o = sc.drone.orbit;
          s.orbiting = true;
          s.drone.phase = 'ORBIT';
          s.drone.orbitAngle = Math.atan2(s.drone.y - o.cy, s.drone.x - o.cx);
          log(s, 'OPERATOR', 'Resumed orbit', a.reason || 'Operator restarted the orbit around the site.');
          return true;
        }

        case 'OP_POINT': {
          if (!operatorHasControl(s)) return false;
          s.camera.target = [a.x, a.y];
          if (a.zoom) s.camera.zoom = a.zoom;
          var where = a.label || ('map point ' + Math.round(a.x) + ', ' + Math.round(a.y));
          var why = a.reason || ('Operator picked the spot on the ' + (a.source || 'map') + '.');
          if (s.garden.choice === 'AWAY') why += ' Garden mask stays on.';
          log(s, 'OPERATOR', 'Pointed camera at ' + where + (a.zoom ? ', zoom ' + a.zoom + '×' : ''), why);
          return true;
        }

        case 'OP_ZOOM':
          if (!operatorHasControl(s) || [1, 2, 4].indexOf(a.zoom) < 0 || a.zoom === s.camera.zoom) return false;
          s.camera.zoom = a.zoom;
          log(s, 'OPERATOR', 'Set camera zoom to ' + a.zoom + '×', a.reason || 'Operator decision.');
          return true;

        case 'OP_MARK_POI': {
          if (!operatorHasControl(s)) return false;
          var id = 'POI-' + (s.pois.length + 1);
          var label = a.label || ('Point ' + (s.pois.length + 1));
          s.pois.push({ id: id, x: a.x, y: a.y, label: label, tick: s.tick });
          log(s, 'OPERATOR', 'Marked ' + id + ': ' + label, a.reason || ('Operator picked the spot on the ' + (a.source || 'map') + '.'));
          if (s.feedShared) log(s, 'SYSTEM', 'Sent ' + id + ' to ' + sc.patrol.id, 'Feed is shared with ' + sc.patrol.id + '.');
          return true;
        }

        case 'OP_SHARE_FEED':
          if (!operatorHasControl(s) || !!a.on === s.feedShared) return false;
          s.feedShared = !!a.on;
          log(s, 'OPERATOR', a.on ? 'Shared the live feed with ' + sc.patrol.id : 'Stopped sharing the feed with ' + sc.patrol.id,
            a.reason || ('Operator decision. Garden of no. 12 is ' + (gardenInFrame(s) ? 'in frame.' : 'out of frame or masked.')));
          if (a.on && s.pois.length) log(s, 'SYSTEM', 'Sent ' + s.pois.length + ' marked point(s) to ' + sc.patrol.id, 'Feed sharing started.');
          return true;

        case 'OP_RECORD':
          if (!operatorHasControl(s) || !!a.on === s.recording) return false;
          s.recording = !!a.on;
          log(s, 'OPERATOR', a.on ? 'Started recording' : 'Stopped recording',
            a.on ? 'Operator decision.' : 'Operator decision. Deviation from DFR-R1 noted.', { rule: 'DFR-R1' });
          return true;

        case 'OP_GARDEN':
          return gardenChoice(s, a.choice);

        case 'OP_ACCEPT_SUGGESTION': {
          if (!operatorHasControl(s) || s.suggestionsUsed[a.id] != null) return false;
          var sg = null;
          sc.suggestions.forEach(function (x) { if (x.id === a.id) sg = x; });
          if (!sg) return false;
          var inner = {};
          Object.keys(sg.action).forEach(function (k) { inner[k] = sg.action[k]; });
          inner.reason = 'Accepted system suggestion ' + sg.id + '.';
          var ok = dispatch(s, inner);
          if (ok) s.suggestionsUsed[a.id] = s.tick;
          return ok;
        }

        case 'OP_END':
          if (s.anchors.P == null) return false;
          if (!(operatorHasControl(s) || s.status === 'PATROL_ONLY')) return false;
          endIncident(s);
          return true;
      }
      return false;
    }

    function gardenChoice(s, choice) {
      var sc = s.sc, det = s.detections['D-02'];
      if (!operatorHasControl(s) || !det || s.garden.choice === choice) return false;
      if (['AWAY', 'MONITOR', 'FLAGGED'].indexOf(choice) < 0) return false;
      var prev = s.garden.choice;
      s.garden.choice = choice;
      s.garden.history.push({ choice: choice, tick: s.tick });
      s.anchors.C = s.tick;
      var changed = prev !== 'PENDING' ? ' (changed from ' + prev.toLowerCase() + ')' : '';
      if (choice === 'AWAY') {
        s.camera.target = sc.feed.privacy.awayTarget.slice();
        log(s, 'OPERATOR', 'Garden detection: pointed camera away' + changed,
          'Privacy. The figure is on private property and is not needed to manage the bay.');
        log(s, 'SYSTEM', 'Masked the garden of no. 12 on the feed and recording', 'Holds while this choice stands.', { rule: 'DFR-P2' });
        det.status = 'Not observed (your choice)';
        if (s.unknowns['U-03']) s.unknowns['U-03'].note = 'Left unresolved by operator choice (privacy).';
      } else if (choice === 'MONITOR') {
        log(s, 'OPERATOR', 'Garden detection: keep monitoring' + changed,
          'Possible suspect; watch before acting. Recording into the garden continues.');
        det.status = 'Monitoring';
      } else {
        log(s, 'OPERATOR', 'Garden detection: flagged to patrol' + changed,
          'Ask ' + sc.patrol.id + ' to check in person instead of deciding from the air.');
        log(s, 'SYSTEM', 'Sent the garden flag and location to ' + sc.patrol.id, 'Operator request.');
        det.status = 'Flagged to ' + sc.patrol.id;
      }
      det.needsHuman = false;
      det.version++;
      return true;
    }

    /* ---- per-tick physics --------------------------------------------- */
    function updateDrone(s) {
      var d = s.drone, cfg = s.sc.drone, el, f, p;
      var px = d.x, py = d.y;
      if (s.airborne) d.battery = Math.max(0, d.battery - cfg.batteryDrainPerS / TPS);

      if (d.phase === 'TRANSIT') {
        el = (s.tick - s.anchors.L) / TPS;
        d.alt = Math.min(cfg.cruiseAltM, cfg.cruiseAltM * el / cfg.climbS);
        f = clamp((el - 3) / (cfg.transitS - 3), 0, 1);
        p = pointAlong(cfg.route, easeInOut(f));
        d.x = p.x; d.y = p.y;
      } else if (d.phase === 'ORBIT') {
        var o = cfg.orbit;
        d.orbitAngle += (2 * Math.PI) / (o.periodS * TPS);
        d.x = o.cx + o.r * Math.cos(d.orbitAngle);
        d.y = o.cy + o.r * Math.sin(d.orbitAngle);
        d.alt = cfg.cruiseAltM;
      } else if (d.phase === 'RTB') {
        el = (s.tick - s.anchors.E) / TPS;
        f = clamp(el / cfg.rtbS, 0, 1);
        p = pointAlong(s.rtbRoute, easeInOut(f));
        d.x = p.x; d.y = p.y;
        d.alt = cfg.cruiseAltM * clamp((cfg.rtbS - el) / cfg.climbS, 0, 1);
      }
      var moved = Math.hypot(d.x - px, d.y - py);
      d.speed = moved * s.sc.map.metresPerUnit * TPS;
      if (moved > 0.001) d.heading = Math.atan2(d.y - py, d.x - px);
    }

    function step(s) {
      if (s.status === 'IDLE' || s.status === 'CLOSED') return false;
      s.tick++;
      if (s.status === 'LAUNCH_GATE' && s.mode === 'SUPERVISED' && s.tick >= s.gateDeadline) {
        launch(s, 'Abort window (' + s.sc.launch.abortWindowS + ' s) ended with no abort.', 'auto-supervised');
      }
      runScript(s);
      updateDrone(s);
      if (s.recording && s.airborne && gardenInFrame(s)) s.metrics.privateRecTicks++;
      return true;
    }

    return {
      create: create, dispatch: dispatch, step: step,
      keyTick: keyTick, matches: matches
    };
  })();

  /* ========================================================================
     2. SELECTORS (pure reads of model state)
     ======================================================================== */

  function nowClock(s, tick) {
    return parseClock(s.sc.clockStart) + (tick == null ? s.tick : tick) / TPS;
  }
  function tSec(s) { return s.tick / TPS; }

  function timeToHandover(s) {
    if (s.anchors.A == null) return null;
    return ((s.anchors.H != null ? s.anchors.H : s.tick) - s.anchors.A) / TPS;
  }

  function isCondensed(s) {
    switch (s.status) {
      case 'TRANSIT': case 'RTB': return true;
      case 'PATROL_ONLY': return s.anchors.P == null;
      case 'ON_SCENE': return s.garden.choice !== 'PENDING' && s.anchors.P == null;
    }
    return false;
  }

  function patrolInfo(s) {
    var p = s.sc.patrol;
    if (s.anchors.T == null) return { x: p.route[0][0], y: p.route[0][1], eta: p.arriveAt, onScene: false, heading: 0 };
    if (s.anchors.P != null) {
      var e = p.route[p.route.length - 1];
      return { x: e[0], y: e[1], eta: 0, onScene: true, heading: 0 };
    }
    var f = clamp(tSec(s) / p.arriveAt, 0, 1), pt = pointAlong(p.route, f);
    return { x: pt.x, y: pt.y, eta: Math.max(0, p.arriveAt - tSec(s)), onScene: false, heading: pt.heading };
  }

  function droneEta(s) {
    var c = s.sc.drone;
    if (s.status === 'TRANSIT') return (s.anchors.L + toTicks(c.transitS) - s.tick) / TPS;
    if (s.status === 'RTB') return (s.anchors.E + toTicks(c.rtbS) - s.tick) / TPS;
    if (s.status === 'IDLE' || s.status === 'INCIDENT_IN' || s.status === 'LAUNCH_GATE') return c.transitS;
    return null;
  }

  function distToSiteKm(s) {
    var site = s.sc.incident.site;
    return Math.hypot(s.drone.x - site[0], s.drone.y - site[1]) * s.sc.map.metresPerUnit / 1000;
  }

  /* Camera view rectangle in world units (what the model treats as "in frame"). */
  function cameraView(s) {
    var f = s.sc.feed, w = f.viewWidth / s.camera.zoom, h = w * f.aspect, d = s.drone, c;
    var ahead = [d.x + Math.cos(d.heading) * f.approachLookAhead, d.y + Math.sin(d.heading) * f.approachLookAhead];
    if (!s.airborne) c = s.sc.drone.dock;
    else if (s.camera.target) c = s.camera.target;
    else if (s.camAuto && s.camAuto.mode === 'SITE') {
      var k = easeInOut(clamp((s.tick - s.camAuto.tick) / (5 * TPS), 0, 1));
      c = [lerp(ahead[0], f.siteTarget[0], k), lerp(ahead[1], f.siteTarget[1], k)];
    } else if (s.status === 'TRANSIT') c = ahead;
    else c = [d.x, d.y];
    return { cx: c[0], cy: c[1], w: w, h: h };
  }

  function privateArea(s) {
    var id = s.sc.feed.privacy.area, g = null;
    s.sc.map.site.gardens.forEach(function (x) { if (x.id === id) g = x; });
    return g;
  }

  function gardenInFrame(s) {
    if (s.garden.choice === 'AWAY') return false;
    var g = privateArea(s);
    if (!g) return false;
    var b = polyBBox(g.pts), v = cameraView(s);
    return b.x1 > v.cx - v.w / 2 && b.x0 < v.cx + v.w / 2 && b.y1 > v.cy - v.h / 2 && b.y0 < v.cy + v.h / 2;
  }

  /* Entity position for the thermal feed; null when not present. */
  function entityAt(s, ent) {
    var tracks = ent.tracks || [];
    for (var i = 0; i < tracks.length; i++) {
      var tr = tracks[i];
      if (!Model.matches(s, tr.when)) continue;
      var ks = tr.keys.map(function (k) { return { t: Model.keyTick(s, k), k: k }; });
      if (ks.some(function (x) { return x.t == null; })) continue;
      if (s.tick < ks[0].t) continue;
      for (var j = ks.length - 1; j >= 0; j--) {
        if (s.tick >= ks[j].t) {
          var a = ks[j], b = ks[j + 1];
          if (a.k.hidden) return null;
          if (!b || b.k.hidden) return { x: a.k.x, y: a.k.y };
          var u = (s.tick - a.t) / Math.max(1, b.t - a.t);
          return { x: lerp(a.k.x, b.k.x, u), y: lerp(a.k.y, b.k.y, u) };
        }
      }
    }
    if (!ent.base) return null;
    var w = ent.wander, t = tSec(s);
    if (!w) return { x: ent.base[0], y: ent.base[1] };
    var ph = (2 * Math.PI * t) / w.periodS;
    return { x: ent.base[0] + w.a * Math.sin(ph), y: ent.base[1] + w.a * 0.6 * Math.sin(ph * 1.7 + 1) };
  }

  function entityById(s, id) {
    var e = null;
    s.sc.entities.forEach(function (x) { if (x.id === id) e = x; });
    return e;
  }

  function sinceLaunch(s) {
    if (s.anchors.L == null) return [];
    return s.audit.filter(function (e) { return e.brief && e.actor === 'SYSTEM' && e.tick >= s.anchors.L; });
  }

  function visibleDecisions(s) {
    if (s.anchors.A == null) return [];
    return s.sc.decisions.filter(function (d) {
      return !d.requires || !d.requires.detected || s.detections[d.requires.detected];
    });
  }

  function suggestionsVisible(s) { return s.anchors.A != null; }

  function gardenOutcomeKey(s) {
    if (s.anchors.L == null) return 'NO_DRONE';
    return s.garden.choice;
  }

  /* expose for tests and debugging */
  window.DFR_MODEL = { Model: Model, MODES: MODES, TPS: TPS, selectors: {
    timeToHandover: timeToHandover, isCondensed: isCondensed, patrolInfo: patrolInfo,
    cameraView: cameraView, gardenInFrame: gardenInFrame, entityAt: entityAt
  } };

  /* @@RENDER@@ */
})();
