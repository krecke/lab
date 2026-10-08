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
        shareDecided: false,
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
        brief: opts.brief ? (typeof opts.brief === 'string' ? opts.brief : action) : null
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
      log(s, 'SYSTEM', 'Launched ' + sc.drone.id + ' from ' + sc.incident.drone.dock, reason, { rule: sc.launch.rule, brief: 'Launched from ' + sc.incident.drone.dock });
      s.recording = true;
      log(s, 'SYSTEM', 'Started recording', 'Recording runs from launch to dock.', { rule: 'DFR-R1' });
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
        'Reached the incident address.', { brief: 'Arrived; orbiting at ' + (o.r * s.sc.map.metresPerUnit) + ' m' });
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
          s.shareDecided = true;
          log(s, 'OPERATOR', a.on ? 'Shared the live feed with ' + sc.patrol.id : 'Stopped sharing the feed with ' + sc.patrol.id,
            a.reason || ('Operator decision. Garden of no. 12 is ' + (gardenInFrame(s) ? 'in frame.' : 'out of frame or masked.')));
          if (a.on && s.pois.length) log(s, 'SYSTEM', 'Sent ' + s.pois.length + ' marked point(s) to ' + sc.patrol.id, 'Feed sharing started.');
          return true;

        case 'OP_SHARE_DECLINE':
          if (!operatorHasControl(s) || s.shareDecided) return false;
          s.shareDecided = true;
          log(s, 'OPERATOR', 'Decided not to share the feed with ' + sc.patrol.id,
            a.reason || 'Operator decision. Sharing stays available from the live view.');
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

  /* The one thing the operator should do now. At most one primary action per state.
     kind: approve | take-control | garden | share | end | wait | none */
  function nextAction(s) {
    switch (s.status) {
      case 'LAUNCH_GATE': return { kind: s.mode === 'INTERACTIVE' ? 'approve' : 'wait' };
      case 'HANDOVER': return { kind: 'take-control' };
      case 'ON_SCENE':
        if (s.detections['D-02'] && s.garden.choice === 'PENDING') return { kind: 'garden' };
        if (!s.shareDecided) return { kind: 'share' };
        if (s.anchors.P != null) return { kind: 'end' };
        return { kind: 'wait' };
      case 'PATROL_ONLY': return { kind: s.anchors.P != null ? 'end' : 'wait' };
      case 'IDLE': case 'CLOSED': return { kind: 'none' };
    }
    return { kind: 'wait' };
  }

  function gardenOutcomeKey(s) {
    if (s.anchors.L == null) return 'NO_DRONE';
    return s.garden.choice;
  }

  /* expose for tests and debugging */
  window.DFR_MODEL = { Model: Model, MODES: MODES, TPS: TPS, selectors: {
    timeToHandover: timeToHandover, isCondensed: isCondensed, patrolInfo: patrolInfo,
    cameraView: cameraView, gardenInFrame: gardenInFrame, entityAt: entityAt
  } };

  /* ========================================================================
     3. PLAYBACK CONTROLLER
     ------------------------------------------------------------------------
     Drives Model.step() at a fixed 10 ticks per scenario second. Speed and
     the condensed factor only change how many ticks run per animation frame,
     so the same operator choices at the same ticks always give the same run.
     ======================================================================== */

  var App = {
    sc: null,
    mode: 'SUPERVISED',
    state: null,
    playing: false,
    speed: 1,
    acc: 0,
    lastTs: null
  };

  /* View-only state. Never read by the model. */
  var ui = {
    dirty: true, lastRev: -1,
    auditOpen: false, auditFilter: 'ALL', auditSeen: 0,
    mapView: 'auto', armed: null, closeoutOpen: true,
    thumbs: {}, camView: null, mapVB: null, mapScale: null
  };

  function newState() {
    App.state = Model.create(App.sc, App.mode);
    App.acc = 0;
    ui.thumbs = {}; ui.armed = null; ui.closeoutOpen = true;
    ui.camView = null; ui.mapVB = null; ui.dirty = true;
  }

  function act(a) {
    var ok = Model.dispatch(App.state, a);
    ui.dirty = true;
    return ok;
  }

  var Playback = {
    play: function () {
      var s = App.state;
      if (s.status === 'CLOSED') return;
      if (s.status === 'IDLE') act({ type: 'START' });
      App.playing = true; ui.dirty = true;
    },
    pause: function () { App.playing = false; ui.dirty = true; },
    toggle: function () { if (App.playing) Playback.pause(); else Playback.play(); },
    setSpeed: function (n) { App.speed = n; ui.dirty = true; },
    restart: function () { App.playing = false; newState(); },
    canJump: function () {
      return ['IDLE', 'INCIDENT_IN', 'LAUNCH_GATE', 'TRANSIT'].indexOf(App.state.status) >= 0;
    },
    jumpToHandover: function () {
      var s = App.state, guard = 0;
      if (!Playback.canJump()) return;
      if (s.status === 'IDLE') act({ type: 'START' });
      while (s.status !== 'HANDOVER' && guard++ < 20000) {
        if (['INCIDENT_IN', 'LAUNCH_GATE', 'TRANSIT'].indexOf(s.status) < 0) break;
        if (s.status === 'LAUNCH_GATE' && s.mode === 'INTERACTIVE') act({ type: 'OP_APPROVE_LAUNCH', via: 'playback' });
        else Model.step(s);
      }
      App.acc = 0; ui.dirty = true;
    }
  };

  function frame(ts) {
    var s = App.state;
    var dt = App.lastTs == null ? 0 : Math.min(0.25, (ts - App.lastTs) / 1000);
    App.lastTs = ts;
    if (App.playing && s.status !== 'IDLE' && s.status !== 'CLOSED') {
      var rate = App.speed * (isCondensed(s) ? s.sc.condenseFactor : 1);
      App.acc += dt * rate * TPS;
      var n = Math.floor(App.acc);
      App.acc -= n;
      for (var i = 0; i < n && i < 400; i++) {
        Model.step(s);
        if (s.status === 'CLOSED') break;
      }
    }
    if (s.status === 'CLOSED' && App.playing) { App.playing = false; ui.dirty = true; }
    try { render(); } catch (err) { console.error(err); }
    requestAnimationFrame(frame);
  }

  /* ========================================================================
     4. RENDERING
     ------------------------------------------------------------------------
     render() runs every animation frame:
       - discrete panels re-render only when model.rev or ui.dirty changes
       - [data-live] text and [data-live-w] bars update every frame
       - map dynamic layer and thermal feed redraw every frame
     ======================================================================== */

  function $(id) { return document.getElementById(id); }

  var STEPS = [
    { n: 1, label: 'Incident in' },
    { n: 2, label: 'Launch' },
    { n: 3, label: 'Transit', sub: 'autonomous' },
    { n: 4, label: 'Handover' },
    { n: 5, label: 'On scene & close-out' }
  ];
  var STEP_OF = { IDLE: 0, INCIDENT_IN: 1, LAUNCH_GATE: 2, TRANSIT: 3, HANDOVER: 4, ON_SCENE: 5, RTB: 5, CLOSED: 5, PATROL_ONLY: 5 };

  function render() {
    var s = App.state;
    if (ui.dirty || s.rev !== ui.lastRev) {
      ui.dirty = false;
      ui.lastRev = s.rev;
      var focusKey = focusedAction();
      renderTopbar(s);
      renderLeft(s);
      renderContext(s);
      renderHarness(s);
      renderMapDiscrete(s);
      renderFeedTools(s);
      renderAudit(s);
      renderCloseout(s);
      renderHints();
      restoreFocus(focusKey);
    }
    renderLive(s);
    renderMapDynamic(s);
    renderFeed(s);
  }

  /* Panels re-render as the scenario runs; keep keyboard focus on the same control. */
  function focusedAction() {
    var a = document.activeElement;
    if (!a || !a.getAttribute || !a.getAttribute('data-action')) return null;
    return { action: a.getAttribute('data-action'), arg: a.getAttribute('data-arg') };
  }
  function restoreFocus(k) {
    if (!k || (document.activeElement && document.activeElement !== document.body)) return;
    var sel = '[data-action="' + k.action + '"]' + (k.arg != null ? '[data-arg="' + k.arg + '"]' : '');
    var el = document.querySelector(sel);
    if (el && !el.disabled) el.focus({ preventScroll: true });
  }

  /* ---- shared bits ------------------------------------------------------ */
  function clockAt(s, tick) { return fmtClock(nowClock(s, tick)); }

  function confHTML(c, verifiedBy) {
    var cls = c == null ? 'conf-ok' : c >= 0.8 ? 'conf-high' : c >= 0.5 ? 'conf-med' : 'conf-low';
    return '<span class="conf ' + cls + ' num">' + esc(fmtConf(c, verifiedBy)) + '</span>';
  }

  function ruleChip(id) {
    if (!id) return '';
    return '<span class="rule" title="' + esc(App.sc.rules[id] || '') + '">' + esc(id) + '</span>';
  }

  function controlInfo(s) {
    switch (s.status) {
      case 'IDLE': return { who: 'No incident', sub: 'Choose a mode, then press Play', cls: 'ctl-idle' };
      case 'INCIDENT_IN': return { who: 'System', sub: 'Checking launch policy', cls: 'ctl-system' };
      case 'LAUNCH_GATE':
        return s.mode === 'INTERACTIVE'
          ? { who: 'System', sub: 'Waiting for your launch decision', cls: 'ctl-system ctl-ask' }
          : { who: 'System', sub: 'Launching automatically', cls: 'ctl-system' };
      case 'TRANSIT': return { who: 'System', sub: 'Autonomous transit', cls: 'ctl-system' };
      case 'HANDOVER': return { who: 'System', sub: 'Orbiting · waiting for you (T)', cls: 'ctl-system ctl-ask' };
      case 'ON_SCENE': return { who: 'Operator', sub: 'You are flying DR-03', cls: 'ctl-operator' };
      case 'RTB': return { who: 'System', sub: 'Autonomous return to dock', cls: 'ctl-system' };
      case 'PATROL_ONLY': return { who: 'System', sub: 'Drone docked · not launched', cls: 'ctl-system' };
      case 'CLOSED': return { who: 'System', sub: 'Drone docked · incident closed', cls: 'ctl-system' };
    }
    return { who: '—', sub: '', cls: '' };
  }

  function phaseLabel(s) {
    var d = s.drone;
    if (s.status === 'LAUNCH_GATE' || s.status === 'INCIDENT_IN') return 'Docked · ready';
    switch (d.phase) {
      case 'DOCKED': return s.status === 'IDLE' ? 'Docked · ready' : 'Docked';
      case 'TRANSIT': return d.alt < s.sc.drone.cruiseAltM ? 'Climbing' : 'Transit';
      case 'ORBIT': return 'Orbit';
      case 'HOLD': return 'Holding';
      case 'RTB': return 'Returning';
    }
    return d.phase;
  }

  /* ---- top bar ---------------------------------------------------------- */
  function renderTopbar(s) {
    var locked = s.status !== 'IDLE';
    var html = '<span class="mode-k">Oversight mode' + (locked ? ' <span class="lock">· locked</span>' : '') + '</span><div class="seg">';
    Object.keys(MODES).forEach(function (k) {
      var on = App.mode === k;
      html += '<button role="radio" aria-checked="' + on + '" class="seg-btn' + (on ? ' on' : '') + '" data-action="mode" data-arg="' + k + '"' +
        (locked ? ' disabled' : '') + ' title="' + esc(MODES[k].summary) + '">' + esc(MODES[k].label) + '</button>';
    });
    $('mode').innerHTML = html + '</div>';

    var c = controlInfo(s);
    $('control').className = 'control ' + c.cls;
    $('control').innerHTML =
      '<span class="ctl-k">In control</span>' +
      '<span class="ctl-who">' + esc(c.who) + '</span>' +
      '<span class="ctl-sub">' + esc(c.sub) + '</span>';

    $('rec').className = 'chip chip-rec' + (s.recording ? ' on' : '');
    $('rec').innerHTML = '<span class="chip-k">Recording</span><span class="chip-v"><span class="rec-dot" aria-hidden="true"></span>' +
      (s.recording ? 'REC · On' : 'Off') + '</span>';

    $('audit-count').textContent = s.audit.length;
  }

  /* ---- left column: incident and steps ----------------------------------- */
  function renderLeft(s) {
    var sc = s.sc, inc = sc.incident, html = '';
    var started = s.status !== 'IDLE';

    html += '<section class="panel card incident' + (started ? '' : ' muted') + '">';
    html += '<div class="card-top"><span class="eyebrow">Incident ' + (started ? '<span class="num">' + esc(inc.ref) + '</span>' : '· none') + '</span>' +
      (started ? '<span class="prio" title="' + esc(inc.priorityNote) + '">' + esc(inc.priority) + '</span>' : '') + '</div>';
    if (!started) {
      html += '<p class="idle-note">No active incident. Waiting for a call.</p>';
    } else {
      html += '<h2 class="inc-type">' + esc(inc.type) + '</h2>' +
        '<div class="inc-addr">' + esc(inc.address) + '<span class="dim"> · ' + esc(inc.district) + '</span></div>' +
        '<dl class="kv">' +
        '<div><dt>Since call</dt><dd class="num" data-live="since-call"></dd></div>' +
        '<div><dt>Caller</dt><dd>' + esc(inc.caller) + '</dd></div>' +
        '</dl>' +
        '<p class="notes"><span class="eyebrow">Caller notes</span>' + esc(inc.callerNotes) + '</p>' +
        '<div class="eta">' +
        '<div class="eta-h"><span class="eyebrow">Arrival</span><span class="dim">' + esc(inc.drone.id) + ' from ' + esc(inc.drone.dock) + ', <span class="num">' + inc.drone.distanceKm + ' km</span></span></div>' +
        etaRow('Drone', 'drone-eta', 'eta-drone', 'sys') +
        etaRow('Patrol ' + inc.patrol.id, 'patrol-eta', 'eta-patrol', 'neutral') +
        '</div>';
    }
    html += '</section>';

    var cur = STEP_OF[s.status], ld = s.launchDecision;
    html += '<section class="panel card steps"><ol class="stepper">';
    STEPS.forEach(function (st) {
      var state = st.n < cur ? 'done' : st.n === cur ? 'current' : 'todo';
      var note = stepNote(s, st.n);
      if (s.status === 'PATROL_ONLY' || (s.status === 'CLOSED' && ld && (ld.how === 'declined' || ld.how === 'aborted'))) {
        if (st.n === 3 || st.n === 4) { state = 'skipped'; note = 'Skipped: no drone'; }
      }
      if (s.status === 'CLOSED' && st.n === 5) state = 'done';
      html += '<li class="step ' + state + '"><span class="step-n num">' + st.n + '</span><span class="step-t"><span>' + esc(st.label) +
        (st.sub ? ' <span class="dim">(' + st.sub + ')</span>' : '') + '</span>' + (note ? '<span class="step-note">' + note + '</span>' : '') + '</span></li>';
    });
    html += '</ol></section>';

    $('left').innerHTML = html;
  }

  function etaRow(label, liveKey, barKey, tone) {
    return '<div class="eta-row"><span class="eta-l">' + esc(label) + '</span>' +
      '<span class="eta-bar"><span class="eta-fill ' + tone + '" data-live-w="' + barKey + '"></span></span>' +
      '<span class="eta-v num" data-live="' + liveKey + '"></span></div>';
  }

  function stepNote(s, n) {
    var a = s.anchors, ld = s.launchDecision;
    if (n === 1 && a.T != null) return clockAt(s, a.T);
    if (n === 2) {
      if (!ld) return s.status === 'LAUNCH_GATE' ? (s.mode === 'INTERACTIVE' ? 'Waiting for your approval' : s.mode === 'SUPERVISED' ? 'Abort window open' : '') : '';
      var t = clockAt(s, ld.tick);
      return {
        'approved': 'Approved by you · ' + t,
        'approved-playback': 'Approved (playback jump) · ' + t,
        'auto-supervised': 'Automatic, not aborted · ' + t,
        'auto-lights-out': 'Automatic, you were notified · ' + t,
        'declined': 'Declined by you · ' + t,
        'aborted': 'Aborted by you · ' + t
      }[ld.how] || t;
    }
    if (n === 3 && a.L != null) return a.A != null ? 'Arrived ' + clockAt(s, a.A) : 'Nothing needs you';
    if (n === 4 && a.A != null) return a.H != null ? 'Taken in ' + fmtMS((a.H - a.A) / TPS) : 'Waiting for you';
    if (n === 5) {
      if (s.status === 'RTB') return 'Returning to dock';
      if (s.status === 'CLOSED') return 'Closed ' + clockAt(s, a.D);
      if (s.status === 'PATROL_ONLY') return 'Patrol only';
      if (s.status === 'ON_SCENE') return 'You have control';
    }
    return '';
  }

  /* ---- right column: decisions, one primary action at a time ------------- */
  function renderContext(s) {
    var html;
    switch (s.status) {
      case 'IDLE': html = ctxIdle(s); break;
      case 'INCIDENT_IN': html = ctxIncidentIn(s); break;
      case 'LAUNCH_GATE': html = ctxLaunchGate(s); break;
      case 'TRANSIT': html = ctxTransit(s); break;
      case 'HANDOVER': html = ctxHandover(s); break;
      case 'ON_SCENE': html = ctxOnScene(s); break;
      case 'RTB': html = ctxRtb(s); break;
      case 'PATROL_ONLY': html = ctxPatrolOnly(s); break;
      case 'CLOSED': html = ctxClosed(s); break;
    }
    var el = $('context');
    var keep = el.scrollTop;
    el.innerHTML = html;
    el.scrollTop = keep;
  }

  /* The "Now" card. tone: ask (needs you) | sys (system acting) | calm (nothing needs you).
     primary: at most one primary button. secondary: quieter alternatives. */
  function nowCard(o) {
    return '<section class="now now-' + o.tone + '" aria-live="polite">' +
      '<div class="now-main">' +
      (o.eyebrow ? '<div class="now-eyebrow">' + o.eyebrow + '</div>' : '') +
      '<h2 class="now-title">' + o.title + '</h2>' +
      (o.body ? '<p class="now-body">' + o.body + '</p>' : '') +
      (o.extra || '') +
      '</div>' +
      (o.side ? '<div class="now-side">' + o.side + '</div>' : '') +
      (o.primary || o.secondary ? '<div class="now-actions">' + (o.primary || '') + (o.secondary || '') + '</div>' : '') +
      '</section>';
  }

  function ctxIdle(s) {
    var html = nowCard({ tone: 'calm', title: 'No active incident', body: 'Waiting for a call. Start the scenario from the prototype bar at the top.' });
    html += '<section class="sec"><h3 class="sec-h">Oversight mode for this incident</h3><ul class="modes">';
    Object.keys(MODES).forEach(function (k) {
      html += '<li class="mode-card' + (App.mode === k ? ' on' : '') + '"><button class="mode-pick" data-action="mode" data-arg="' + k + '" aria-pressed="' + (App.mode === k) + '">' +
        '<span class="mode-name">' + esc(MODES[k].label) + (App.mode === k ? ' <span class="dim">· selected</span>' : '') + '</span><span class="mode-sum">' + esc(MODES[k].summary) + '</span></button></li>';
    });
    html += '</ul><p class="fine">Chosen before the incident and locked while it runs. In every mode, the reason for launch and the rule that allowed it go into the audit trail.</p></section>';
    return html;
  }

  function ctxIncidentIn(s) {
    return nowCard({ tone: 'calm', eyebrow: 'Nothing needs you', title: 'Checking launch policy', body: 'Incident received. The system is checking rule ' + ruleChip(s.sc.launch.rule) + '.' }) +
      launchReasons(s, 'What it is checking');
  }

  function launchReasons(s, title) {
    var html = '<section class="sec"><h3 class="sec-h">' + esc(title) + ' ' + ruleChip(s.sc.launch.rule) + '</h3><ul class="reasons">';
    s.sc.launch.reasons.forEach(function (r) { html += '<li>' + esc(r) + '</li>'; });
    return html + '</ul><p class="fine">' + esc(s.sc.rules[s.sc.launch.rule]) + '</p></section>';
  }

  function ctxLaunchGate(s) {
    var sc = s.sc;
    if (s.mode === 'INTERACTIVE') {
      return nowCard({
        tone: 'ask', eyebrow: 'Needs you · waiting <span class="num" data-live="gate-wait"></span>',
        title: 'Launch ' + esc(sc.drone.id) + ' to ' + esc(sc.incident.address) + '?',
        body: 'The system recommends it and will not launch without you. Patrol ' + esc(sc.patrol.id) + ' is dispatched either way.',
        primary: '<button class="btn btn-primary-ask btn-lg" data-action="approve">Approve launch</button>',
        secondary: '<button class="btn btn-quiet" data-action="decline">Don\'t launch</button>'
      }) + launchReasons(s, 'Why the system recommends it');
    }
    return nowCard({
      tone: 'sys', eyebrow: 'System acting · nothing needs you',
      title: 'Launching in <span class="num" data-live="abort-left"></span> s',
      body: 'Supervised mode. The system launches ' + esc(sc.drone.id) + ' when the window closes. Abort only if something is wrong.',
      extra: '<div class="countdown" role="progressbar" aria-label="Abort window remaining"><span class="countdown-fill" data-live-w="abort-bar"></span></div>',
      secondary: '<button class="btn btn-quiet" data-action="abort">Abort launch</button>'
    }) + launchReasons(s, 'Why it is launching');
  }

  function lastLaunchNotice(s) {
    var ld = s.launchDecision, sc = s.sc;
    if (!ld) return '';
    var t = '<span class="num">' + clockAt(s, ld.tick) + '</span>', msg;
    if (ld.how === 'auto-lights-out') msg = '<b>Launched without asking you</b> at ' + t + '. Lights-out mode, rule ' + ruleChip(sc.launch.rule) + '.';
    else if (ld.how === 'auto-supervised') msg = '<b>Launched automatically</b> at ' + t + ' after the abort window. Rule ' + ruleChip(sc.launch.rule) + '.';
    else if (ld.how === 'approved-playback') msg = '<b>Launched</b> at ' + t + '. Approval came from the playback jump and is logged as such.';
    else msg = '<b>Launched on your approval</b> at ' + t + '. Rule ' + ruleChip(sc.launch.rule) + '.';
    return '<p class="notice">' + msg + ' <button class="link" data-action="toggle-audit">See audit</button></p>';
  }

  function ctxTransit(s) {
    return nowCard({
      tone: 'calm', eyebrow: 'Nothing needs you', title: esc(s.sc.drone.id) + ' arrives in <span class="num" data-live="drone-eta-plain"></span>',
      body: 'It is flying itself to ' + esc(s.sc.incident.address) + '. You will be asked to take over when it gets there.',
      extra: lastLaunchNotice(s)
    }) + briefHTML(s, 'building');
  }

  function ctxHandover(s) {
    return nowCard({
      tone: 'ask', eyebrow: 'Needs you', title: 'Take over ' + esc(s.sc.drone.id),
      body: 'It keeps orbiting and acts on nothing below until you do.',
      side: '<div class="tth"><span class="eyebrow">Time-to-handover</span><span class="num big" data-live="tth"></span></div>' +
        '<button class="btn btn-primary-ask btn-lg" data-action="take-control">Take control <kbd>T</kbd></button>'
    }) + briefHTML(s, 'handover');
  }

  function ctxOnScene(s) {
    var sc = s.sc, next = nextAction(s).kind, det = s.detections['D-02'], html = '';
    html += '<div class="status-line"><span><b>You have control</b> · took over in <span class="num">' + fmtMS(timeToHandover(s)) + '</span></span>' +
      '<span>Patrol ' + esc(sc.patrol.id) + ' <b class="num" data-live="patrol-eta"></b></span></div>';

    if (next === 'garden') {
      var dg = sc.decisions[0];
      html += nowCard({
        tone: 'ask', eyebrow: 'Decide now · 1 of 2', title: esc(dg.title) + ' ' + confHTML(det.confidence),
        body: esc(dg.text) + ' The system will not choose for you, and you can change your choice later.',
        extra: '<div class="choices">' + dg.choices.map(function (c) {
          return '<button class="btn choice" data-action="garden" data-arg="' + c.choice + '"><span class="choice-l">' + esc(c.label) + '</span><span class="choice-n">' + esc(c.note) + '</span></button>';
        }).join('') + '</div>'
      });
    } else if (next === 'share') {
      var ds = sc.decisions[1];
      html += nowCard({
        tone: 'ask', eyebrow: 'Decide now · 2 of 2', title: esc(ds.title), body: esc(ds.text) +
          (s.garden.choice === 'AWAY' ? ' The garden is masked on the shared feed.' : ''),
        primary: '<button class="btn btn-primary-ask" data-action="share" data-arg="on">Share feed</button>',
        secondary: '<button class="btn btn-quiet" data-action="share-decline">Don\'t share</button>'
      });
    } else if (next === 'end') {
      html += nowCard({
        tone: 'ask', eyebrow: 'Needs you', title: 'Patrol ' + esc(sc.patrol.id) + ' is on scene',
        body: 'End the incident when the aerial view is no longer needed. ' + esc(sc.drone.id) + ' flies itself back to the dock.',
        primary: '<button class="btn btn-primary-ask btn-lg" data-action="end">End incident</button>'
      });
    } else {
      html += nowCard({
        tone: 'calm', eyebrow: 'Nothing needs you', title: 'Patrol ' + esc(sc.patrol.id) + ' arrives in <span class="num" data-live="patrol-eta"></span>',
        body: 'You will be asked to end the incident when it is on scene. Until then, use the live view controls for a closer look if you want.'
      });
    }

    html += decisionsMade(s);
    if (next !== 'end') html += suggestionsHTML(s, true);
    html += '<div class="brief-grid">' + detectedHTML(s) + unknownsHTML(s) + '</div>';
    return html;
  }

  /* Resolved decisions, with quiet links to revise them. */
  function decisionsMade(s) {
    var sc = s.sc, rows = [];
    if (s.garden.choice !== 'PENDING') {
      var dg = sc.decisions[0], cur = s.garden.choice, last = s.garden.history[s.garden.history.length - 1];
      var lbl = dg.choices.filter(function (c) { return c.choice === cur; })[0];
      rows.push('<li><span class="made-t">' + esc(dg.title) + '</span><span class="made-v">You chose <b>' + esc(lbl.label.toLowerCase()) + '</b> · <span class="num">' + clockAt(s, last.tick) + '</span></span>' +
        '<span class="made-change">Change to ' + dg.choices.filter(function (c) { return c.choice !== cur; }).map(function (c) {
          return '<button class="link" data-action="garden" data-arg="' + c.choice + '">' + esc(c.label.toLowerCase()) + '</button>';
        }).join(' or ') + '</span></li>');
    }
    if (s.shareDecided) {
      rows.push('<li><span class="made-t">Live feed to ' + esc(sc.patrol.id) + '</span><span class="made-v">' + (s.feedShared ? '<b>Shared</b>' : '<b>Not shared</b>') + '</span>' +
        '<span class="made-change"><button class="link" data-action="share" data-arg="' + (s.feedShared ? 'off' : 'on') + '">' + (s.feedShared ? 'Stop sharing' : 'Share now') + '</button></span></li>');
    }
    if (!rows.length) return '';
    return '<section class="sec"><h3 class="sec-h">Your decisions</h3><ul class="made">' + rows.join('') + '</ul></section>';
  }

  function ctxRtb(s) {
    return nowCard({ tone: 'calm', eyebrow: 'Nothing needs you', title: esc(s.sc.drone.id) + ' docks in <span class="num" data-live="drone-eta-plain"></span>',
      body: 'It is flying itself back to ' + esc(s.sc.incident.drone.dock) + '. The close-out summary opens when it docks.' }) +
      '<div class="brief-grid">' + detectedHTML(s) + unknownsHTML(s) + '</div>';
  }

  function ctxPatrolOnly(s) {
    var sc = s.sc, p = patrolInfo(s), ld = s.launchDecision;
    var note = '<p class="notice"><b>' + esc(sc.drone.id) + ' was not launched.</b> ' +
      (ld.how === 'declined' ? 'You declined the recommendation' : 'You aborted the automatic launch') +
      ' at <span class="num">' + clockAt(s, ld.tick) + '</span>. <button class="link" data-action="toggle-audit">See audit</button></p>';
    if (!p.onScene) {
      return nowCard({ tone: 'calm', eyebrow: 'Nothing needs you', title: 'Patrol ' + esc(sc.patrol.id) + ' arrives in <span class="num" data-live="patrol-eta"></span>',
        body: 'It is on its way without an aerial view.', extra: note });
    }
    return nowCard({ tone: 'ask', eyebrow: 'Needs you', title: 'Patrol ' + esc(sc.patrol.id) + ' is on scene',
      body: 'End the incident on the console.', extra: note,
      primary: '<button class="btn btn-primary-ask btn-lg" data-action="end">End incident</button>' });
  }

  function ctxClosed(s) {
    return nowCard({ tone: 'calm', title: 'Incident closed', body: 'Drone docked. The close-out summary shows who did what, and when.',
      secondary: '<button class="btn" data-action="closeout-open">Show close-out summary</button>' });
  }

  /* ---- handover brief ---------------------------------------------------- */
  /* mode: 'building' (transit, filling in) | 'handover'. No buttons in the brief:
     the only action at handover is Take control. */
  function briefHTML(s, mode) {
    var sc = s.sc, html = '<div class="brief' + (mode === 'building' ? ' building' : '') + '">';
    html += '<section class="sec"><h3 class="sec-h"><span class="sec-n">1</span>What the drone is looking at<span class="sec-aside">Handover brief · ' +
      (mode === 'building' ? 'filling in as the drone flies' : 'prepared by the system at <span class="num">' + clockAt(s, s.anchors.A) + '</span>') + '</span></h3>';
    if (s.anchors.A != null) html += '<p class="looking">' + esc(sc.brief.lookingAt) + '</p>';
    else if (s.camAuto) html += '<p class="looking pending">Camera on the site, <span class="num" data-live="tel-dist"></span> out. One-line summary on arrival.</p>';
    else html += '<p class="looking pending">Camera looking ahead along the route. Site not in view yet.</p>';
    html += '</section>';

    var did = sinceLaunch(s);
    html += '<section class="sec"><h3 class="sec-h"><span class="sec-n">2</span>What the system did since launch</h3><ol class="did">';
    did.forEach(function (e) {
      html += '<li title="' + esc(e.action + ' — ' + e.reason) + '"><span class="num did-t">' + clockAt(s, e.tick) + '</span><span class="did-a">' + esc(e.brief) + '</span></li>';
    });
    if (!did.length) html += '<li class="pending">Nothing yet.</li>';
    html += '</ol></section>';

    var cap = ui.briefAll ? 0 : 3;
    html += '<div class="brief-grid">' + detectedHTML(s, 3, cap) + unknownsHTML(s, 4, cap) + '</div>';
    if (s.detOrder.length > 3 || s.unkOrder.length > 3) {
      html += '<button class="link more" data-action="brief-all">' + (ui.briefAll ? 'Show fewer' : 'Show all ' + s.detOrder.length + ' detections and ' + s.unkOrder.length + ' unknowns') + '</button>';
    }

    // 5. decisions: listed, not actionable until take control
    var decs = visibleDecisions(s);
    html += '<section class="sec"><h3 class="sec-h"><span class="sec-n">5</span>Decisions waiting for you <span class="dim">· most urgent first</span></h3>';
    if (mode === 'building') {
      html += s.detections['D-02']
        ? '<p class="queued">Queued for when you take over: <b>figure in a private garden</b> ' + confHTML(s.detections['D-02'].confidence) + '. The drone is not acting on it.</p>'
        : '<p class="pending">None yet.</p>';
    } else {
      html += '<ol class="dec-list">' + decs.map(function (d, i) {
        var conf = d.kind === 'garden' && s.detections['D-02'] ? ' ' + confHTML(s.detections['D-02'].confidence) : '';
        var opts = d.choices ? '<div class="dec-x">Options: ' + d.choices.map(function (c) { return c.label.toLowerCase(); }).join(', ') + '.</div>' : '';
        return '<li class="' + (i === 0 ? 'first' : '') + '"><span class="dec-n">' + esc(d.urgency) + '</span><div><div class="dec-t">' + esc(d.title) + conf + '</div>' + opts + '</div></li>';
      }).join('') + '</ol>';
    }
    html += '</section>';

    html += suggestionsHTML(s, false, mode);
    return html + '</div>';
  }

  /* Decision-relevant items first, then scenario order. cap = 0 shows all. */
  function ranked(ids, first) {
    return ids.filter(function (id) { return first(id); }).concat(ids.filter(function (id) { return !first(id); }));
  }

  function detectedHTML(s, n, cap) {
    var html = '<section class="sec half"><h3 class="sec-h">' + (n ? '<span class="sec-n">' + n + '</span>' : '') + 'What it detected <span class="count num">' + s.detOrder.length + '</span>' +
      '<span class="fr-tag" title="Facial recognition is not part of this programme. Identity is never inferred from the feed."><span class="strike">FR</span> off</span></h3><ul class="items">';
    var ids = ranked(s.detOrder, function (id) { return s.detections[id].needsHuman; });
    if (cap) ids = ids.slice(0, cap);
    ids.forEach(function (id) {
      var d = s.detections[id];
      var masked = d.privateArea && s.garden.choice === 'AWAY';
      var status = d.needsHuman ? '<div class="item-s ask">Needs your decision</div>' : (d.status !== 'Detected' ? '<div class="item-s">' + esc(d.status) + '</div>' : '');
      html += '<li class="item' + (d.needsHuman ? ' needs' : '') + '" title="' + esc(id + ' · evidence: ' + d.evidence) + '">' +
        '<div class="thumb">' + (masked ? '<span class="thumb-mask">Masked</span>' : '<img alt="Evidence for ' + esc(id) + ': thermal crop" src="' + thumbFor(s, d) + '">') +
        '<span class="thumb-id num">' + esc(id) + '</span></div>' +
        '<div class="item-b"><div class="item-l">' + confHTML(d.confidence, d.verifiedBy) + esc(d.label) + '</div>' + status + '</div></li>';
    });
    if (!s.detOrder.length) html += '<li class="item pending"><div class="thumb"></div><div class="item-b"><div class="item-l">Nothing detected yet.</div></div></li>';
    return html + '</ul></section>';
  }

  function unknownsHTML(s, n, cap) {
    var html = '<section class="sec half"><h3 class="sec-h">' + (n ? '<span class="sec-n">' + n + '</span>' : '') + 'What it doesn\'t know <span class="count num">' + s.unkOrder.length + '</span></h3><ul class="items">';
    var ids = ranked(s.unkOrder, function (id) { return id === 'U-03' || id === 'U-04'; });
    if (cap) ids = ids.slice(0, cap);
    ids.forEach(function (id) {
      var u = s.unknowns[id], det = s.detections['D-02'];
      var conf = id === 'U-03' && det ? confHTML(det.confidence, det.verifiedBy) : '';
      html += '<li class="item unk' + (u.resolved ? ' resolved' : '') + '" title="' + esc(id) + '"><div class="thumb unk-mark" aria-hidden="true">?<span class="thumb-id num">' + esc(id) + '</span></div>' +
        '<div class="item-b"><div class="item-l">' + conf + esc(u.text) + '</div>' +
        (u.note ? '<div class="item-s">' + esc(u.note) + '</div>' : '') + '</div></li>';
    });
    if (!s.unkOrder.length) html += '<li class="item pending"><div class="thumb unk-mark">?</div><div class="item-b"><div class="item-l">Nothing listed yet.</div></div></li>';
    return html + '</ul></section>';
  }

  /* Suggestions are always secondary: quiet buttons, and none before take control. */
  function suggestionsHTML(s, live, mode) {
    var html = '<section class="sec sugg"><h3 class="sec-h">' + (live ? '' : '<span class="sec-n">6</span>') + 'Suggested first actions <span class="dim">· ' +
      (live ? 'optional · nothing runs until you act' : 'suggestions only · usable after you take control') + '</span></h3>';
    if (!suggestionsVisible(s)) return html + '<p class="pending">Prepared on arrival.</p></section>';
    var list = s.sc.suggestions;
    if (live && list.every(function (g) { return s.suggestionsUsed[g.id] != null; })) return '';
    html += '<ul class="suggs' + (live ? ' live' : '') + '">';
    list.forEach(function (g) {
      var used = s.suggestionsUsed[g.id];
      html += '<li class="sg' + (used != null ? ' used' : '') + '"><span class="item-id num">' + esc(g.id) + '</span><span class="sg-t">' + esc(g.text) + '</span>' +
        (!live ? '' : used != null ? '<span class="sg-done num">Done ' + clockAt(s, used) + '</span>'
          : '<button class="btn btn-quiet btn-sm" data-action="suggest" data-arg="' + g.id + '">Do it</button>') + '</li>';
    });
    return html + '</ul></section>';
  }

  /* ---- live view toolbar: drone and camera controls, attached to the view ---- */
  function renderFeedTools(s) {
    var el = $('feed-tools');
    $('feed-title').innerHTML = s.airborne ? 'Live view' : 'Live view <span class="dim">· off</span>';
    if (s.status !== 'ON_SCENE') {
      var msg = {
        IDLE: 'No drone in the air.',
        INCIDENT_IN: 'DR-03 is docked.',
        LAUNCH_GATE: 'DR-03 is docked. No live view until launch.',
        TRANSIT: 'Controls unlock when you take control.',
        HANDOVER: 'Holding DR-03 in orbit. Controls unlock when you take control.',
        RTB: 'Flying DR-03 back to the dock.',
        PATROL_ONLY: 'DR-03 was not launched.',
        CLOSED: 'DR-03 is docked. Feed ended.'
      }[s.status];
      el.className = 'feed-tools off';
      el.innerHTML = '<div class="tools-row">' + (s.airborne ? '<span class="steer steer-sys">System steering</span>' : '') +
        '<span class="tools-msg">' + esc(msg) + '</span></div>';
      return;
    }
    var z = s.camera.zoom, armed = ui.armed;
    var row1 = '<span class="steer steer-op">You are steering</span><span class="tools-sep" aria-hidden="true"></span>' +
      '<button class="btn btn-sm tool-toggle' + (s.recording ? ' on' : '') + '" data-action="rec" data-arg="' + (s.recording ? 'off' : 'on') + '" aria-pressed="' + s.recording + '">' +
      '<span class="rec-dot" aria-hidden="true"></span>' + (s.recording ? 'Recording' : 'Not recording') + '</button>' +
      '<button class="btn btn-sm tool-toggle' + (s.feedShared ? ' on' : '') + '" data-action="share" data-arg="' + (s.feedShared ? 'off' : 'on') + '" aria-pressed="' + s.feedShared + '">' +
      (s.feedShared ? 'Shared with ' : 'Not shared with ') + esc(s.sc.patrol.id) + '</button>';
    var row2 = '<div class="seg" role="group" aria-label="Flight">' +
      '<button class="seg-btn' + (s.orbiting ? ' on' : '') + '" data-action="orbit" aria-pressed="' + s.orbiting + '">Orbit</button>' +
      '<button class="seg-btn' + (!s.orbiting ? ' on' : '') + '" data-action="hold" aria-pressed="' + !s.orbiting + '">Hold</button></div>' +
      '<div class="seg" role="group" aria-label="Zoom">' + [1, 2, 4].map(function (n) {
        return '<button class="seg-btn num' + (z === n ? ' on' : '') + '" data-action="zoom" data-arg="' + n + '" aria-pressed="' + (z === n) + '">' + n + '×</button>';
      }).join('') + '</div>' +
      '<div class="seg" role="group" aria-label="Pick a spot on the view or map">' +
      '<button class="seg-btn' + (armed === 'point' ? ' on' : '') + '" data-action="arm" data-arg="point" aria-pressed="' + (armed === 'point') + '" title="Point the camera: then click the view or the map">Point</button>' +
      '<button class="seg-btn' + (armed === 'poi' ? ' on' : '') + '" data-action="arm" data-arg="poi" aria-pressed="' + (armed === 'poi') + '" title="Mark a point of interest: then click the view or the map">Mark</button></div>' +
      '<span class="tools-sep" aria-hidden="true"></span><span class="tool-hint">' + (s.orbiting ? 'Orbiting 80 m' : 'Holding position') + '</span>';
    el.className = 'feed-tools';
    el.innerHTML = '<div class="tools-row">' + row1 + '</div><div class="tools-row">' + row2 + '</div>';
  }

  function renderHints() {
    var on = !!ui.armed && App.state.status === 'ON_SCENE';
    ['map-hint', 'feed-hint'].forEach(function (id) {
      var el = $(id);
      el.hidden = !on;
      if (on) el.textContent = ui.armed === 'point' ? 'Click to point the camera here · Esc to cancel' : 'Click to mark a point of interest · Esc to cancel';
    });
    $('map-wrap').classList.toggle('armed', on);
    $('feed-wrap').classList.toggle('armed', on);
  }

  /* ---- live values (every frame) ---------------------------------------- */
  var LIVE = {
    'clock': function (s) { return s.status === 'IDLE' ? clockAt(s, 0) : clockAt(s); },
    'tplus': function (s) { return 'Scenario T+' + fmtMS(tSec(s)); },
    'condense-x': function (s) { return s.sc.condenseFactor + '×'; },
    'since-call': function (s) { return fmtMS(tSec(s) - s.sc.incident.callReceivedS); },
    'drone-eta': function (s) {
      if (s.status === 'PATROL_ONLY' || (s.status === 'CLOSED' && s.anchors.L == null)) return 'Not sent';
      if (s.status === 'CLOSED') return 'Docked';
      if (s.status === 'RTB') return 'Returning';
      if (s.anchors.A != null) return 'Arrived';
      var e = droneEta(s); return e == null ? '—' : fmtMS(e);
    },
    'drone-eta-plain': function (s) { var e = droneEta(s); return e == null ? '—' : fmtMS(e); },
    'patrol-eta': function (s) { var p = patrolInfo(s); return p.onScene ? 'On scene' : fmtMS(p.eta); },
    'tth': function (s) { return fmtMS(timeToHandover(s)); },
    'gate-wait': function (s) { return s.anchors.G == null ? '0:00' : fmtMS((s.tick - s.anchors.G) / TPS); },
    'abort-left': function (s) { return s.gateDeadline == null ? '' : Math.max(0, Math.ceil((s.gateDeadline - s.tick) / TPS)); },
    'tel-phase': function (s) { return phaseLabel(s); },
    'tel-alt': function (s) { return Math.round(s.drone.alt) + ' m'; },
    'tel-speed': function (s) { return Math.round(s.drone.speed) + ' m/s'; },
    'tel-bat': function (s) { return s.drone.battery.toFixed(0) + '%'; },
    'tel-link': function (s) {
      if (!s.airborne) return 'Dock';
      var l = s.drone.link; return (l >= 90 ? 'Good' : l >= 75 ? 'Fair' : 'Poor') + ' · ' + l + '%';
    },
    'tel-dist': function (s) { return distToSiteKm(s).toFixed(2) + ' km'; },
    'tel-eta': function (s) {
      if (s.status === 'TRANSIT') return 'Site ' + fmtMS(droneEta(s));
      if (s.status === 'RTB') return 'Dock ' + fmtMS(droneEta(s));
      if (s.status === 'HANDOVER' || s.status === 'ON_SCENE') return 'On scene';
      return '—';
    },
    'private-rec': function (s) { return fmtMS(s.metrics.privateRecTicks / TPS); }
  };
  var LIVE_W = {
    'abort-bar': function (s) {
      if (s.gateDeadline == null) return 100;
      return clamp((s.gateDeadline - s.tick) / toTicks(s.sc.launch.abortWindowS), 0, 1) * 100;
    },
    'eta-drone': function (s) {
      var max = s.sc.incident.patrol.etaS;
      if (s.status === 'PATROL_ONLY' || s.anchors.A != null) return 0;
      return clamp((droneEta(s) || 0) / max, 0, 1) * 100;
    },
    'eta-patrol': function (s) { return clamp(patrolInfo(s).eta / s.sc.incident.patrol.etaS, 0, 1) * 100; },
    'progress': function (s) { return clamp(tSec(s) / timelineSpan(s), 0, 1) * 100; }
  };

  function renderLive(s) {
    var els = document.querySelectorAll('[data-live]');
    for (var i = 0; i < els.length; i++) {
      var f = LIVE[els[i].getAttribute('data-live')];
      if (!f) continue;
      var v = String(f(s));
      if (els[i].textContent !== v) els[i].textContent = v;
    }
    var bars = document.querySelectorAll('[data-live-w]');
    for (var j = 0; j < bars.length; j++) {
      var g = LIVE_W[bars[j].getAttribute('data-live-w')];
      if (g) bars[j].style.width = g(s).toFixed(2) + '%';
    }
    var cz = $('condensed');
    var cond = App.playing && isCondensed(s);
    if (cz.hidden === cond) cz.hidden = !cond;
  }

  /* ---- prototype harness (simulation playback, not part of the console) --- */
  function timelineSpan(s) {
    return s.sc.patrol.arriveAt + 60 + s.sc.drone.rtbS + 20;
  }

  function renderHarness(s) {
    var sc = s.sc, span = timelineSpan(s), a = s.anchors, playing = App.playing;
    var html = '<div class="h-id"><span class="h-tag">Prototype</span><span class="h-name">Simulation playback · not part of the console</span></div>';
    html += '<div class="h-ctrls">' +
      '<button class="hbtn hbtn-main" data-action="' + (playing ? 'pause' : 'play') + '"' + (s.status === 'CLOSED' ? ' disabled' : '') + '>' +
      (playing ? '<span class="ico-pause" aria-hidden="true"></span>Pause' : '<span class="ico-play" aria-hidden="true"></span>' + (s.status === 'IDLE' ? 'Start scenario' : 'Play')) + ' <kbd>Space</kbd></button>' +
      '<div class="hseg" role="group" aria-label="Speed">' + [1, 2, 4].map(function (n) {
        return '<button class="hbtn num' + (App.speed === n ? ' on' : '') + '" data-action="speed" data-arg="' + n + '" aria-pressed="' + (App.speed === n) + '">' + n + '×</button>';
      }).join('') + '</div>' +
      '<button class="hbtn" data-action="restart">Restart</button>' +
      '<button class="hbtn" data-action="jump"' + (Playback.canJump() ? '' : ' disabled') + '>Jump to handover</button></div>';

    var marks = [
      { t: a.L != null ? a.L / TPS : null, label: 'Launch' },
      { t: a.A != null ? a.A / TPS : null, label: 'Arrival' },
      { t: a.H != null ? a.H / TPS : null, label: 'Control' },
      { t: sc.patrol.arriveAt, label: 'Patrol' },
      { t: a.E != null ? a.E / TPS : null, label: 'End' },
      { t: a.D != null && a.L != null ? a.D / TPS : null, label: 'Docked' }
    ];
    html += '<div class="h-time num"><span data-live="tplus"></span><span class="condensed" id="condensed" hidden>quiet stretch ×<span data-live="condense-x"></span></span></div>';
    html += '<div class="h-track" aria-hidden="true"><div class="h-rail"><span class="h-fill" data-live-w="progress"></span>';
    var lastPct = -100, up = false;
    marks.forEach(function (m) {
      if (m.t == null) return;
      var past = s.tick / TPS >= m.t, pct = clamp(m.t / span * 100, 0, 100);
      up = pct - lastPct < 7 ? !up : false;
      lastPct = pct;
      html += '<span class="h-mark' + (past ? ' past' : '') + (up ? ' up' : '') + '" style="left:' + pct.toFixed(2) + '%"><span>' + m.label + '</span></span>';
    });
    html += '</div></div>';
    $('harness').innerHTML = html;
  }

  /* ---- audit drawer ------------------------------------------------------ */
  function renderAudit(s) {
    var el = $('audit');
    el.hidden = !ui.auditOpen;
    if (!ui.auditOpen) return;
    var f = ui.auditFilter;
    var list = s.audit.filter(function (e) { return f === 'ALL' || e.actor === f; });
    var html = '<div class="drawer-head"><div><h2 class="drawer-t">Audit trail</h2><span class="dim num">' + s.audit.length + ' entries · append-only</span></div>' +
      '<div class="seg">' + ['ALL', 'SYSTEM', 'OPERATOR'].map(function (k) {
        return '<button class="seg-btn' + (f === k ? ' on' : '') + '" data-action="audit-filter" data-arg="' + k + '">' + (k === 'ALL' ? 'All' : k.charAt(0) + k.slice(1).toLowerCase()) + '</button>';
      }).join('') + '</div>' +
      '<button class="btn" data-action="toggle-audit">Close <kbd>Esc</kbd></button></div>';
    html += '<ol class="audit-list" id="audit-list">';
    list.forEach(function (e) {
      html += '<li class="ae ae-' + e.actor.toLowerCase() + '"><div class="ae-t num">' + clockAt(s, e.tick) + '<span class="dim">T+' + fmtMS(e.tick / TPS) + '</span></div>' +
        '<div class="ae-actor"><span class="actor actor-' + e.actor.toLowerCase() + '">' + e.actor + '</span></div>' +
        '<div class="ae-b"><div class="ae-a">' + esc(e.action) + '</div><div class="ae-r"><span class="dim">Reason:</span> ' + esc(e.reason) + ' ' + ruleChip(e.rule) + '</div></div></li>';
    });
    if (!list.length) html += '<li class="pending">No entries yet.</li>';
    el.innerHTML = html + '</ol>';
    var lst = $('audit-list');
    lst.scrollTop = lst.scrollHeight;
  }

  /* ---- close-out --------------------------------------------------------- */
  function launchSummary(s) {
    var ld = s.launchDecision, a = s.anchors;
    if (!ld) return '—';
    var waited = a.G != null ? fmtMS((ld.tick - a.G) / TPS) : '';
    return {
      'approved': 'Approved by you after ' + waited,
      'approved-playback': 'Approved by playback jump',
      'auto-supervised': 'Automatic; abort window not used',
      'auto-lights-out': 'Automatic; you were notified',
      'declined': 'Declined by you after ' + waited,
      'aborted': 'Aborted by you after ' + waited
    }[ld.how];
  }

  function renderCloseout(s) {
    var el = $('closeout');
    var show = s.status === 'CLOSED' && ui.closeoutOpen;
    el.hidden = !show;
    if (!show) return;
    var sc = s.sc, a = s.anchors, tth = timeToHandover(s);
    var sys = s.audit.filter(function (e) { return e.actor === 'SYSTEM'; }).length;
    var op = s.audit.length - sys;
    var gk = gardenOutcomeKey(s);
    var gLabel = { AWAY: 'Pointed camera away', MONITOR: 'Kept monitoring', FLAGGED: 'Flagged to patrol', PENDING: 'No decision', NO_DRONE: 'Never seen' }[gk];
    var air = a.L != null ? fmtMS((a.D - a.L) / TPS) : '—';

    var html = '<div class="co-head"><div><span class="eyebrow">Close-out · <span class="num">' + esc(sc.incident.ref) + '</span></span>' +
      '<h2 class="co-title">' + esc(sc.incident.type) + ', ' + esc(sc.incident.address) + '</h2>' +
      '<span class="dim">Mode: ' + esc(MODES[s.mode].label) + ' · Incident in <span class="num">' + clockAt(s, a.T) + '</span> · Closed <span class="num">' + clockAt(s, a.D) + '</span></span></div>' +
      '<div class="actions"><button class="btn" data-action="toggle-audit">Full audit trail</button><button class="btn" data-action="closeout-close">Back to console</button>' +
      '<button class="btn btn-primary" data-action="restart">Restart scenario</button></div></div>';

    html += '<div class="co-metrics">' +
      metric('Time-to-handover', tth == null ? 'n/a' : fmtMS(tth), tth == null ? 'Drone not launched' : 'Arrival ' + clockAt(s, a.A) + ' → you took control ' + clockAt(s, a.H), true) +
      metric('Launch', launchSummary(s), ruleChip(sc.launch.rule) + ' ' + MODES[s.mode].label + ' mode') +
      metric('Drone airborne', air, a.L != null ? 'Launch ' + clockAt(s, a.L) + ' → docked ' + clockAt(s, a.D) : 'Stayed docked') +
      metric('Garden detection', gLabel, s.garden.history.length > 1 ? 'Changed ' + (s.garden.history.length - 1) + '×' : '') +
      metric('Recorded into private garden', fmtMS(s.metrics.privateRecTicks / TPS), 'Seconds of recording with the garden in frame, unmasked') +
      metric('Actions logged', '<span class="num">' + sys + '</span> system · <span class="num">' + op + '</span> you', 'Every entry has a reason') +
      '</div>';

    html += '<div class="co-body"><div class="co-left">';
    html += '<section class="sec"><h3 class="sec-h">Garden detection outcome</h3><p class="co-out">' + esc(sc.outcomes[gk]) + '</p></section>';
    var open = s.unkOrder.filter(function (id) { return !s.unknowns[id].resolved; });
    html += '<section class="sec"><h3 class="sec-h">Still unknown at close</h3><ul class="co-unk">' +
      (open.length ? open.map(function (id) {
        var u = s.unknowns[id];
        return '<li><span class="item-id num">' + id + '</span> ' + esc(u.text) + (u.note ? ' <span class="dim">' + esc(u.note) + '</span>' : '') + '</li>';
      }).join('') : '<li class="pending">' + (s.anchors.L == null ? 'No aerial view, so nothing was listed.' : 'Nothing listed.') + '</li>') + '</ul></section>';
    html += '</div>';

    html += '<section class="sec co-swim"><h3 class="sec-h">Who did what, when</h3><div class="swim-head"><span>System</span><span></span><span>Operator (you)</span></div><ol class="swim">';
    s.audit.forEach(function (e) {
      var cell = '<div class="sw-a">' + esc(e.action) + '</div><div class="sw-r">' + esc(e.reason) + '</div>';
      html += '<li class="sw sw-' + e.actor.toLowerCase() + '"><div class="sw-sys">' + (e.actor === 'SYSTEM' ? cell : '') + '</div>' +
        '<div class="sw-t num">' + clockAt(s, e.tick) + '</div><div class="sw-op">' + (e.actor === 'OPERATOR' ? cell : '') + '</div></li>';
    });
    html += '</ol></section></div>';
    el.innerHTML = html;
  }

  function metric(k, v, sub, key) {
    var numeric = /^[\d:.\s]+$/.test(v);
    return '<div class="metric' + (key ? ' key' : '') + '"><span class="eyebrow">' + k + '</span><span class="metric-v' + (numeric ? ' num' : '') + '">' + v + '</span><span class="metric-s">' + (sub || '') + '</span></div>';
  }

  /* ---- map ---------------------------------------------------------------- */
  var SVGNS = 'http://www.w3.org/2000/svg';
  var mapEls = {};

  function ptsAttr(pts) { return pts.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' '); }

  function buildMapStatic() {
    var sc = App.sc, m = sc.map, site = m.site, h = '';
    h += '<defs>' +
      '<pattern id="hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="4" class="hatch-line"/></pattern>' +
      '<pattern id="hatch-nfz" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="10" class="nfz-hatch"/></pattern>' +
      '</defs>';
    h += '<rect x="-2000" y="-2000" width="5000" height="5000" class="m-bg"/>';
    h += '<polygon class="m-river" points="' + ptsAttr(m.river) + '"/>';
    m.blocks.forEach(function (b) { h += '<rect class="m-block" x="' + b[0] + '" y="' + b[1] + '" width="' + b[2] + '" height="' + b[3] + '"/>'; });
    m.streets.forEach(function (st) { h += '<polyline class="m-street" stroke-width="' + st.w + '" points="' + ptsAttr(st.pts) + '"/>'; });
    m.landmarks.forEach(function (l) {
      h += '<rect class="m-landmark" x="' + l.rect[0] + '" y="' + l.rect[1] + '" width="' + l.rect[2] + '" height="' + l.rect[3] + '"/>';
    });
    m.noFly.forEach(function (z) {
      h += '<circle class="m-nfz" cx="' + z.cx + '" cy="' + z.cy + '" r="' + z.r + '"/>';
      h += '<circle class="m-helipad" cx="' + z.cx + '" cy="' + z.cy + '" r="7"/>';
    });
    // site detail
    site.gardens.forEach(function (g) { h += '<polygon class="m-garden' + (g.private ? ' private' : '') + '" points="' + ptsAttr(g.pts) + '"/>'; });
    h += '<rect class="m-fence" x="' + site.fence[0] + '" y="' + site.fence[1] + '" width="' + site.fence[2] + '" height="' + site.fence[3] + '"/>';
    h += '<rect class="m-apron" x="' + site.apron[0] + '" y="' + site.apron[1] + '" width="' + site.apron[2] + '" height="' + site.apron[3] + '"/>';
    site.buildings.forEach(function (b) {
      h += '<rect class="m-bldg' + (b.id === 'warehouse' ? ' target' : '') + '" x="' + b.rect[0] + '" y="' + b.rect[1] + '" width="' + b.rect[2] + '" height="' + b.rect[3] + '"/>';
    });
    site.trees.forEach(function (t) { h += '<circle class="m-tree" cx="' + t[0] + '" cy="' + t[1] + '" r="' + t[2] + '"/>'; });
    h += '<polyline class="m-route-plan" points="' + ptsAttr(sc.drone.route) + '"/>';
    h += '<polyline class="m-patrol-plan" points="' + ptsAttr(sc.patrol.route) + '"/>';

    // labels (constant pixel size via .mk scale)
    var L = function (x, y, text, cls, rot) {
      return '<g transform="translate(' + x + ' ' + y + ')' + (rot ? ' rotate(' + rot + ')' : '') + '"><g class="mk"><text class="lbl ' + (cls || '') + '">' + esc(text) + '</text></g></g>';
    };
    m.labels.forEach(function (l) { h += L(l.x, l.y, l.text, 'lbl-area', l.rotate); });
    m.landmarks.forEach(function (l) { h += L(l.rect[0] + l.rect[2] / 2, l.rect[1] - 6, l.label, 'lbl-area lbl-mark'); });
    m.noFly.forEach(function (z) { h += L(z.cx, z.cy - z.r - 6, z.label, 'lbl-area lbl-nfz'); });
    site.buildings.forEach(function (b) { h += L(b.rect[0] + b.rect[2] / 2, b.rect[1] + b.rect[3] / 2 + 3, b.label, 'lbl-site'); });
    site.gardens.forEach(function (g) {
      var bb = polyBBox(g.pts);
      if (g.id === sc.feed.privacy.area) h += L((bb.x0 + bb.x1) / 2, bb.y0 + 6, 'Private garden', 'lbl-site lbl-private');
    });
    h += L(site.siteLabel.x, site.siteLabel.y, site.siteLabel.text, 'lbl-site lbl-strong');
    h += L(700, 213, 'Lagerweg', 'lbl-site');

    h += '<g id="m-disc"></g>';
    h += '<g id="m-dyn">' +
      '<polyline id="m-flown" class="m-route-flown" points=""/>' +
      '<circle id="m-orbit" class="m-orbit" r="' + sc.drone.orbit.r + '" cx="' + sc.drone.orbit.cx + '" cy="' + sc.drone.orbit.cy + '"/>' +
      '<rect id="m-cam" class="m-cam"/>' +
      '<g id="m-patrol"><g class="mk"><rect x="-6" y="-6" width="12" height="12" rx="2" class="m-patrol-ico"/><text class="lbl lbl-ico" x="10" y="4">' + esc(sc.patrol.id) + '</text></g></g>' +
      '<g id="m-drone"><g class="mk"><circle class="m-drone-halo" r="14"/><g id="m-drone-rot"><path class="m-drone-ico" d="M10,0 L-7,-7 L-3,0 L-7,7 Z"/></g><text class="lbl lbl-ico" x="12" y="-8">' + esc(sc.drone.id) + '</text></g></g>' +
      '</g>';
    var svg = $('map');
    svg.innerHTML = h;
    mapEls = { svg: svg, flown: $('m-flown'), orbit: $('m-orbit'), cam: $('m-cam'), patrol: $('m-patrol'), drone: $('m-drone'), rot: $('m-drone-rot'), disc: $('m-disc') };
  }

  function renderMapDiscrete(s) {
    var h = '', sc = s.sc;
    // incident pin
    var site = sc.incident.site;
    if (s.status !== 'IDLE') h += '<g transform="translate(' + site[0] + ' ' + site[1] + ')"><g class="mk"><circle r="5" class="m-pin"/><circle r="11" class="m-pin-ring"/></g></g>';
    // privacy mask
    if (s.garden.choice === 'AWAY') {
      var g = privateArea(s);
      var gb = polyBBox(g.pts);
      h += '<polygon class="m-mask" points="' + ptsAttr(g.pts) + '"/>' +
        '<g transform="translate(' + ((gb.x0 + gb.x1) / 2) + ' ' + ((gb.y0 + gb.y1) / 2) + ')"><g class="mk"><text class="lbl lbl-ico" text-anchor="middle" y="4">Masked</text></g></g>';
    }
    // detections
    s.detOrder.forEach(function (id) {
      var d = s.detections[id], ent = entityById(s, d.entity), p = ent && entityAt(s, ent);
      if (!p || (d.privateArea && s.garden.choice === 'AWAY')) return;
      var cls = d.needsHuman ? 'ask' : d.verifiedBy ? 'ok' : 'sys';
      h += '<g transform="translate(' + p.x.toFixed(1) + ' ' + p.y.toFixed(1) + ')"><g class="mk"><rect class="m-det ' + cls + '" x="-4" y="-4" width="8" height="8"><title>' + esc(id + ' ' + d.label) + '</title></rect>' +
        (d.needsHuman ? '<text class="lbl lbl-det" x="8" y="4">' + esc(id) + '</text>' : '') + '</g></g>';
    });
    // POIs
    s.pois.forEach(function (p) {
      h += '<g transform="translate(' + p.x.toFixed(1) + ' ' + p.y.toFixed(1) + ')"><g class="mk"><path class="m-poi" d="M0,-7 L7,0 L0,7 L-7,0 Z"/><text class="lbl lbl-ico" x="10" y="4">' + esc(p.id) + '</text></g></g>';
    });
    mapEls.disc.innerHTML = h;
    // view selector
    var mv = ui.mapView;
    $('map-view').innerHTML = ['auto', 'area', 'site'].map(function (k) {
      return '<button class="seg-btn' + (mv === k ? ' on' : '') + '" data-action="map-view" data-arg="' + k + '" aria-pressed="' + (mv === k) + '">' + k.charAt(0).toUpperCase() + k.slice(1) + '</button>';
    }).join('');
  }

  function desiredMapView(s) {
    var v = s.sc.map.views;
    if (ui.mapView === 'area') return v.area;
    if (ui.mapView === 'site') return v.site;
    if (s.status === 'HANDOVER' || s.status === 'ON_SCENE') return v.site;
    if (s.status === 'TRANSIT' && distToSiteKm(s) < 0.45) return v.site;
    return v.area;
  }

  function renderMapDynamic(s) {
    var svg = mapEls.svg; if (!svg) return;
    var target = desiredMapView(s);
    if (!ui.mapVB) ui.mapVB = target.slice();
    var changed = false;
    for (var i = 0; i < 4; i++) {
      var nv = lerp(ui.mapVB[i], target[i], 0.12);
      if (Math.abs(nv - target[i]) < 0.05) nv = target[i];
      if (nv !== ui.mapVB[i]) { ui.mapVB[i] = nv; changed = true; }
    }
    var vb = ui.mapVB, cw = svg.clientWidth || 600, ch = svg.clientHeight || 360;
    var scale = Math.min(cw / vb[2], ch / vb[3]);
    if (changed || ui.mapScale !== scale) {
      svg.setAttribute('viewBox', vb.map(function (x) { return x.toFixed(2); }).join(' '));
      svg.style.setProperty('--inv', (1 / scale).toFixed(4));
      svg.classList.toggle('zoomed', scale > 1.4);
      ui.mapScale = scale;
      ui.mapScale = scale;
    }
    var d = s.drone;
    mapEls.drone.setAttribute('transform', 'translate(' + d.x.toFixed(2) + ' ' + d.y.toFixed(2) + ')');
    mapEls.rot.setAttribute('transform', 'rotate(' + (d.heading * 180 / Math.PI).toFixed(1) + ')');
    mapEls.drone.setAttribute('class', 'm-drone ' + (s.status === 'HANDOVER' ? 'ask' : s.controller === 'OPERATOR' ? 'op' : 'sys') + (s.airborne ? '' : ' docked'));
    var p = patrolInfo(s);
    mapEls.patrol.setAttribute('transform', 'translate(' + p.x.toFixed(2) + ' ' + p.y.toFixed(2) + ')');
    mapEls.patrol.style.display = s.status === 'IDLE' ? 'none' : '';
    svg.classList.toggle('masked', s.garden.choice === 'AWAY');
    mapEls.orbit.style.display = (s.status === 'HANDOVER' || (s.status === 'ON_SCENE' && s.orbiting)) ? '' : 'none';
    // flown path
    var flown = '';
    if (s.anchors.L != null) {
      var cfg = s.sc.drone, el, f;
      if (s.status === 'TRANSIT') {
        el = (s.tick - s.anchors.L) / TPS; f = easeInOut(clamp((el - 3) / (cfg.transitS - 3), 0, 1));
        flown = ptsAttr(routeUpTo(cfg.route, f));
      } else if (s.status !== 'RTB' && s.status !== 'CLOSED') flown = ptsAttr(cfg.route);
    }
    mapEls.flown.setAttribute('points', flown);
    // camera footprint
    if (s.airborne) {
      var v = ui.camView || cameraView(s);
      mapEls.cam.setAttribute('x', (v.cx - v.w / 2).toFixed(2)); mapEls.cam.setAttribute('y', (v.cy - v.h / 2).toFixed(2));
      mapEls.cam.setAttribute('width', v.w.toFixed(2)); mapEls.cam.setAttribute('height', v.h.toFixed(2));
      mapEls.cam.style.display = '';
    } else mapEls.cam.style.display = 'none';
  }

  function routeUpTo(pts, f) {
    var total = polyLength(pts), d = f * total, out = [pts[0]];
    for (var i = 1; i < pts.length; i++) {
      var seg = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (d >= seg) { out.push(pts[i]); d -= seg; }
      else { var k = seg ? d / seg : 0; out.push([lerp(pts[i - 1][0], pts[i][0], k), lerp(pts[i - 1][1], pts[i][1], k)]); break; }
    }
    return out;
  }

  /* ---- thermal feed -------------------------------------------------------- */
  var feedCtx = null, noiseCanvas = null;

  function makeNoise() {
    var c = document.createElement('canvas'); c.width = c.height = 128;
    var x = c.getContext('2d'), img = x.createImageData(128, 128), seed = 1337;
    function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
    for (var i = 0; i < img.data.length; i += 4) {
      var v = Math.floor(rnd() * 255);
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 22;
    }
    x.putImageData(img, 0, 0);
    return c;
  }

  function gray(v, a) { v = Math.round(clamp(v, 0, 255)); return a == null ? 'rgb(' + v + ',' + v + ',' + v + ')' : 'rgba(' + v + ',' + v + ',' + v + ',' + a + ')'; }

  /* Draws the simulated thermal scene for a world-space view into ctx. */
  function drawScene(ctx, W, H, view, s, opts) {
    opts = opts || {};
    var sc = s.sc, m = sc.map, site = m.site;
    var k = Math.min(W / view.w, H / view.h);
    var ox = W / 2 - view.cx * k, oy = H / 2 - view.cy * k;
    function X(x) { return ox + x * k; }
    function Y(y) { return oy + y * k; }
    function poly(pts) { ctx.beginPath(); pts.forEach(function (p, i) { if (i) ctx.lineTo(X(p[0]), Y(p[1])); else ctx.moveTo(X(p[0]), Y(p[1])); }); ctx.closePath(); }
    function rect(r) { ctx.fillRect(X(r[0]), Y(r[1]), r[2] * k, r[3] * k); }

    ctx.save();
    ctx.fillStyle = gray(30); ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = gray(14); poly(m.river); ctx.fill();
    ctx.fillStyle = gray(23); site.gardens.forEach(function (g) { poly(g.pts); ctx.fill(); });
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    m.streets.forEach(function (st) {
      ctx.strokeStyle = gray(54); ctx.lineWidth = st.w * k;
      ctx.beginPath(); st.pts.forEach(function (p, i) { if (i) ctx.lineTo(X(p[0]), Y(p[1])); else ctx.moveTo(X(p[0]), Y(p[1])); }); ctx.stroke();
    });
    m.blocks.forEach(function (b) { ctx.fillStyle = gray(42); rect(b); ctx.strokeStyle = gray(60); ctx.lineWidth = Math.max(1, 0.4 * k); ctx.strokeRect(X(b[0]), Y(b[1]), b[2] * k, b[3] * k); });
    m.landmarks.forEach(function (l) { ctx.fillStyle = gray(70); rect(l.rect); });
    ctx.fillStyle = gray(48); rect(site.apron);
    ctx.strokeStyle = gray(78); ctx.lineWidth = Math.max(1, 0.35 * k); ctx.setLineDash([2 * k, 1.2 * k]);
    ctx.strokeRect(X(site.fence[0]), Y(site.fence[1]), site.fence[2] * k, site.fence[3] * k); ctx.setLineDash([]);
    site.buildings.forEach(function (b) {
      ctx.fillStyle = gray(40 + b.roof * 110); rect(b.rect);
      ctx.strokeStyle = gray(72 + b.roof * 80); ctx.lineWidth = Math.max(1, 0.5 * k); ctx.strokeRect(X(b.rect[0]), Y(b.rect[1]), b.rect[2] * k, b.rect[3] * k);
      if (b.id === 'warehouse') {
        ctx.strokeStyle = gray(56); ctx.lineWidth = Math.max(1, 0.3 * k);
        for (var i = 1; i < 6; i++) { var xx = b.rect[0] + i * b.rect[2] / 6; ctx.beginPath(); ctx.moveTo(X(xx), Y(b.rect[1] + 2)); ctx.lineTo(X(xx), Y(b.rect[1] + b.rect[3] - 2)); ctx.stroke(); }
      }
    });
    ctx.fillStyle = gray(66); rect(site.pallets);

    // warm entities
    sc.entities.forEach(function (e) {
      var p = entityAt(s, e); if (!p) return;
      var x = X(p.x), y = Y(p.y), g;
      if (e.kind === 'heatleak') {
        g = ctx.createLinearGradient(0, y, 0, y + 5 * k);
        g.addColorStop(0, gray(225, 0.9)); g.addColorStop(1, gray(225, 0));
        ctx.fillStyle = g; ctx.fillRect(x - 6 * k, y, 12 * k, 5 * k);
      } else if (e.kind === 'vehicle' || e.kind === 'car') {
        ctx.fillStyle = gray(e.kind === 'car' ? 150 : 115); ctx.fillRect(x - 3 * k, y - 1.3 * k, 6 * k, 2.6 * k);
        g = ctx.createRadialGradient(x + 2 * k, y, 0, x + 2 * k, y, 2.4 * k);
        g.addColorStop(0, gray(245, 1)); g.addColorStop(1, gray(245, 0));
        ctx.fillStyle = g; ctx.fillRect(x - 1 * k, y - 2.5 * k, 6 * k, 5 * k);
      } else if (e.kind === 'light') {
        g = ctx.createRadialGradient(x, y, 0, x, y, 3 * k);
        g.addColorStop(0, gray(255, 1)); g.addColorStop(1, gray(255, 0));
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, 3 * k, 0, Math.PI * 2); ctx.fill();
      } else if (e.kind === 'person') {
        g = ctx.createRadialGradient(x, y, 0, x, y, 1.5 * k);
        g.addColorStop(0, gray(255, 1)); g.addColorStop(0.45, gray(235, 0.9)); g.addColorStop(1, gray(200, 0));
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, 1.5 * k, 0, Math.PI * 2); ctx.fill();
      }
    });
    // trees: cool canopy, partly occluding
    site.trees.forEach(function (t) {
      ctx.fillStyle = gray(20, 0.78); ctx.beginPath(); ctx.arc(X(t[0]), Y(t[1]), t[2] * k, 0, Math.PI * 2); ctx.fill();
    });

    if (opts.noise && noiseCanvas) {
      var off = (s.tick * 37) % 128;
      ctx.save(); ctx.translate(-off, -((s.tick * 53) % 128));
      ctx.fillStyle = ctx.createPattern(noiseCanvas, 'repeat'); ctx.fillRect(0, 0, W + 128, H + 128);
      ctx.restore();
    }

    // privacy mask
    if (s.garden.choice === 'AWAY') {
      var pa = privateArea(s);
      ctx.save(); poly(pa.pts); ctx.clip();
      ctx.fillStyle = 'rgb(16,19,24)'; ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = 'rgba(178,187,199,0.35)'; ctx.lineWidth = 1;
      for (var hx = -H; hx < W; hx += 8) { ctx.beginPath(); ctx.moveTo(hx, H); ctx.lineTo(hx + H, 0); ctx.stroke(); }
      ctx.restore();
      if (opts.overlay) {
        var bb = polyBBox(pa.pts);
        label(ctx, X(bb.x0) + 4, Y((bb.y0 + bb.y1) / 2), 'PRIVATE AREA · MASKED BY OPERATOR', '#b2bbc7', true);
      }
    }

    if (opts.overlay) {
      // detection boxes; labels are nudged up so they never overlap
      var placed = [];
      s.detOrder.forEach(function (id) {
        var d = s.detections[id];
        if (d.privateArea && s.garden.choice === 'AWAY') return;
        var ent = entityById(s, d.entity), p = entityAt(s, ent);
        if (!p) return;
        var col = d.needsHuman ? '#f2b545' : d.verifiedBy ? '#e7ebf0' : '#4cc3e0';
        var w = d.size[0] * k, h = d.size[1] * k, x0 = X(p.x) - w / 2, y0 = Y(p.y) - h / 2;
        brackets(ctx, x0, y0, w, h, col, d.needsHuman ? 2 : 1.5);
        var txt = id + ' ' + d.kind.toUpperCase() + ' · ' + fmtConf(d.confidence, d.verifiedBy).toUpperCase();
        ctx.font = '600 11px ' + MONO;
        var tw = ctx.measureText(txt).width + 6, lx = clamp(x0, 4, W - tw), ly = Math.max(38, y0 - 4), guard = 0;
        while (guard++ < 8 && placed.some(function (r) { return lx - 3 < r.x + r.w && lx - 3 + tw > r.x && ly - 12 < r.y + r.h && ly + 4 > r.y; })) ly = ly - 17 < 38 ? ly + 34 : ly - 17;
        placed.push({ x: lx - 3, y: ly - 12, w: tw, h: 16 });
        if (Math.abs(ly - (y0 - 4)) > 2) { ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(clamp(x0, lx, lx + tw), ly + 4); ctx.lineTo(x0, y0); ctx.stroke(); }
        label(ctx, lx, ly, txt, col);
      });
      s.pois.forEach(function (p) {
        var x = X(p.x), y = Y(p.y);
        ctx.strokeStyle = '#e7ebf0'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(x, y - 7); ctx.lineTo(x + 7, y); ctx.lineTo(x, y + 7); ctx.lineTo(x - 7, y); ctx.closePath(); ctx.stroke();
        label(ctx, x + 10, y + 4, p.id + ' ' + p.label.toUpperCase(), '#e7ebf0');
      });
    }
    if (opts.box) {
      var bd = opts.box, be = entityAt(s, entityById(s, bd.entity));
      if (be) {
        var bw = bd.size[0] * k, bh = bd.size[1] * k;
        brackets(ctx, X(be.x) - bw / 2, Y(be.y) - bh / 2, bw, bh, bd.needsHuman ? '#f2b545' : '#4cc3e0', 1.5);
      }
    }
    // vignette
    if (opts.noise) {
      var vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
      vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.45)');
      ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
    }
    ctx.restore();
    return { k: k, ox: ox, oy: oy };
  }

  function brackets(ctx, x, y, w, h, col, lw) {
    var c = Math.min(8, w / 3, h / 3);
    ctx.strokeStyle = col; ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(x, y + c); ctx.lineTo(x, y); ctx.lineTo(x + c, y);
    ctx.moveTo(x + w - c, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + c);
    ctx.moveTo(x + w, y + h - c); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w - c, y + h);
    ctx.moveTo(x + c, y + h); ctx.lineTo(x, y + h); ctx.lineTo(x, y + h - c);
    ctx.stroke();
  }

  function label(ctx, x, y, text, col, plain) {
    ctx.font = '600 11px ' + MONO;
    var w = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(11,14,18,0.88)';
    ctx.fillRect(x - 3, y - 12, w + 6, 16);
    ctx.fillStyle = col;
    ctx.fillText(text, x, y);
  }

  var MONO = '"JetBrains Mono", "SF Mono", ui-monospace, Menlo, Consolas, monospace';

  function renderFeed(s) {
    var cv = $('feed'), wrap = $('feed-wrap');
    var dpr = window.devicePixelRatio || 1;
    var W = wrap.clientWidth, H = wrap.clientHeight;
    if (!W || !H) return;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      cv.style.width = W + 'px'; cv.style.height = H + 'px';
    }
    if (!feedCtx) feedCtx = cv.getContext('2d');
    var ctx = feedCtx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // smooth the camera toward the model's view (display only)
    var target = cameraView(s);
    if (!ui.camView) ui.camView = { cx: target.cx, cy: target.cy, w: target.w, h: target.h };
    var cvw = ui.camView, a = 0.18;
    cvw.cx = lerp(cvw.cx, target.cx, a); cvw.cy = lerp(cvw.cy, target.cy, a);
    cvw.w = lerp(cvw.w, target.w, a); cvw.h = lerp(cvw.h, target.h, a);
    var view = { cx: cvw.cx, cy: cvw.cy, w: cvw.w, h: Math.max(cvw.h, cvw.w * H / W) };
    ui.feedXf = null;

    if (!s.airborne) {
      ctx.fillStyle = '#0d1014'; ctx.fillRect(0, 0, W, H);
      var msg = s.status === 'IDLE' ? 'NO ACTIVE INCIDENT' : s.status === 'CLOSED' ? 'DR-03 DOCKED · FEED ENDED' : s.status === 'PATROL_ONLY' ? 'DR-03 NOT LAUNCHED · NO FEED' : 'DR-03 DOCKED · NO LIVE FEED';
      ctx.font = '600 12px ' + MONO; ctx.fillStyle = '#8c96a3'; ctx.textAlign = 'center';
      ctx.fillText(msg, W / 2, H / 2); ctx.textAlign = 'left';
      hud(ctx, W, H, s);
      return;
    }
    ui.feedXf = drawScene(ctx, W, H, view, s, { overlay: true, noise: true });
    ui.feedView = view;
    // reticle
    ctx.strokeStyle = 'rgba(231,235,240,0.35)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(W / 2 - 10, H / 2); ctx.lineTo(W / 2 - 4, H / 2); ctx.moveTo(W / 2 + 4, H / 2); ctx.lineTo(W / 2 + 10, H / 2);
    ctx.moveTo(W / 2, H / 2 - 10); ctx.lineTo(W / 2, H / 2 - 4); ctx.moveTo(W / 2, H / 2 + 4); ctx.lineTo(W / 2, H / 2 + 10); ctx.stroke();
    hud(ctx, W, H, s, ui.feedXf.k);
  }

  function hud(ctx, W, H, s, k) {
    var sc = s.sc;
    ctx.font = '600 11px ' + MONO;
    ctx.fillStyle = 'rgba(11,14,18,0.78)'; ctx.fillRect(0, 0, W, 22); ctx.fillRect(0, H - 22, W, 22);
    ctx.fillStyle = '#b2bbc7';
    var mode = s.airborne ? phaseLabel(s).toUpperCase() : 'DOCKED';
    ctx.fillText((s.airborne ? 'LIVE · ' : '') + sc.drone.id + ' THERMAL · ' + mode + ' · ZOOM ' + s.camera.zoom + '×', 8, 15);
    var rec = s.recording ? '● REC ' + clockAt(s) : '○ NOT RECORDING';
    ctx.fillStyle = s.recording ? '#e7ebf0' : '#8c96a3';
    ctx.textAlign = 'right'; ctx.fillText(rec, W - 8, 15);
    ctx.fillStyle = '#8c96a3';
    ctx.fillText(s.feedShared ? 'FEED SHARED WITH ' + sc.patrol.id : 'FEED NOT SHARED', W - 8, H - 7);
    ctx.textAlign = 'left';
    ctx.fillText('FACIAL RECOGNITION: DISABLED BY DESIGN', 8, H - 7);
    if (k) {
      var m20 = 20 / sc.map.metresPerUnit * k, bx = W - 18 - m20, by = H - 30;
      ctx.strokeStyle = '#b2bbc7'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(bx, by - 3); ctx.lineTo(bx, by); ctx.lineTo(bx + m20, by); ctx.lineTo(bx + m20, by - 3); ctx.stroke();
      ctx.textAlign = 'center'; ctx.fillStyle = '#e7ebf0'; ctx.fillText('20 m', bx + m20 / 2, by - 5); ctx.textAlign = 'left';
    }
  }

  /* Evidence thumbnail: thermal crop around a detection, captured once per version. */
  function thumbFor(s, d) {
    var key = d.id + ':' + d.version;
    if (ui.thumbs[key]) return ui.thumbs[key];
    var c = document.createElement('canvas'); c.width = 112; c.height = 76;
    var ent = entityAt(s, entityById(s, d.entity));
    if (!ent) {
      var prev = ui.thumbs[d.id + ':' + (d.version - 1)];
      if (prev) return (ui.thumbs[key] = prev);
      ent = { x: s.sc.incident.site[0], y: s.sc.incident.site[1] };
    }
    var span = Math.max(d.size[0], d.size[1]) * 3.2;
    drawScene(c.getContext('2d'), 112, 76, { cx: ent.x, cy: ent.y, w: span, h: span * 76 / 112 }, s, { box: d });
    ui.thumbs[key] = c.toDataURL('image/png');
    return ui.thumbs[key];
  }

  /* ========================================================================
     5. INPUT
     ======================================================================== */

  function handleAction(name, arg) {
    var s = App.state;
    switch (name) {
      case 'mode':
        if (s.status !== 'IDLE' || !MODES[arg]) return;
        App.mode = arg; newState(); return;
      case 'play': Playback.play(); return;
      case 'pause': Playback.pause(); return;
      case 'speed': Playback.setSpeed(Number(arg)); return;
      case 'restart': Playback.restart(); return;
      case 'jump': Playback.jumpToHandover(); return;
      case 'approve': act({ type: 'OP_APPROVE_LAUNCH' }); return;
      case 'decline': act({ type: 'OP_DECLINE_LAUNCH' }); return;
      case 'abort': act({ type: 'OP_ABORT_LAUNCH' }); return;
      case 'take-control': act({ type: 'OP_TAKE_CONTROL' }); return;
      case 'hold': act({ type: 'OP_HOLD' }); return;
      case 'orbit': act({ type: 'OP_ORBIT' }); return;
      case 'zoom': act({ type: 'OP_ZOOM', zoom: Number(arg) }); return;
      case 'arm': ui.armed = (arg && ui.armed !== arg) ? arg : null; ui.dirty = true; return;
      case 'rec': act({ type: 'OP_RECORD', on: arg === 'on' }); return;
      case 'share': act({ type: 'OP_SHARE_FEED', on: arg === 'on' }); return;
      case 'share-decline': act({ type: 'OP_SHARE_DECLINE' }); return;
      case 'garden': act({ type: 'OP_GARDEN', choice: arg }); return;
      case 'suggest': act({ type: 'OP_ACCEPT_SUGGESTION', id: arg }); return;
      case 'end': act({ type: 'OP_END' }); return;
      case 'toggle-audit': ui.auditOpen = !ui.auditOpen; ui.dirty = true; return;
      case 'audit-filter': ui.auditFilter = arg; ui.dirty = true; return;
      case 'closeout-open': ui.closeoutOpen = true; ui.dirty = true; return;
      case 'closeout-close': ui.closeoutOpen = false; ui.dirty = true; return;
      case 'map-view': ui.mapView = arg; ui.dirty = true; return;
      case 'brief-all': ui.briefAll = !ui.briefAll; ui.dirty = true; return;
    }
  }

  function placeArmed(x, y, source) {
    if (!ui.armed || App.state.status !== 'ON_SCENE') return;
    if (ui.armed === 'point') act({ type: 'OP_POINT', x: x, y: y, source: source });
    else act({ type: 'OP_MARK_POI', x: x, y: y, source: source });
    ui.armed = null; ui.dirty = true;
  }

  function bindInput() {
    document.addEventListener('click', function (ev) {
      var t = ev.target.closest('[data-action]');
      if (!t || t.disabled) return;
      handleAction(t.getAttribute('data-action'), t.getAttribute('data-arg'));
    });

    $('map').addEventListener('click', function (ev) {
      if (!ui.armed) return;
      var svg = $('map'), pt = svg.createSVGPoint();
      pt.x = ev.clientX; pt.y = ev.clientY;
      var w = pt.matrixTransform(svg.getScreenCTM().inverse());
      placeArmed(w.x, w.y, 'map');
    });

    $('feed').addEventListener('click', function (ev) {
      if (!ui.armed || !ui.feedXf) return;
      var r = $('feed').getBoundingClientRect(), xf = ui.feedXf;
      placeArmed((ev.clientX - r.left - xf.ox) / xf.k, (ev.clientY - r.top - xf.oy) / xf.k, 'feed');
    });

    document.addEventListener('keydown', function (ev) {
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      var tag = (ev.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (ev.key === ' ' || ev.code === 'Space') { ev.preventDefault(); Playback.toggle(); }
      else if (ev.key === 't' || ev.key === 'T') { act({ type: 'OP_TAKE_CONTROL' }); }
      else if (ev.key === 'a' || ev.key === 'A') { handleAction('toggle-audit'); }
      else if (ev.key === 'Escape') {
        if (ui.armed) { ui.armed = null; ui.dirty = true; }
        else if (ui.auditOpen) { ui.auditOpen = false; ui.dirty = true; }
      }
    });

    document.addEventListener('keyup', function (ev) {
      if (ev.key === ' ' || ev.code === 'Space') ev.preventDefault();   // Space is play/pause, never a button press
    });

    window.addEventListener('resize', function () { ui.mapScale = null; ui.dirty = true; });
  }

  /* ========================================================================
     6. BOOT
     ======================================================================== */

  function boot() {
    var id = window.DFR_SCENARIO_ID, sc = window.DFR_SCENARIOS && window.DFR_SCENARIOS[id];
    if (!sc) { document.body.textContent = 'Scenario "' + id + '" not found.'; return; }
    App.sc = sc;
    noiseCanvas = makeNoise();
    newState();
    buildMapStatic();
    bindInput();
    requestAnimationFrame(frame);

    /* Test and demo hooks. */
    window.DFR = {
      state: function () { return App.state; },
      act: act,
      step: function (n) { for (var i = 0; i < (n || 1); i++) Model.step(App.state); ui.dirty = true; },
      play: Playback.play, pause: Playback.pause, speed: Playback.setSpeed,
      restart: Playback.restart, jump: Playback.jumpToHandover,
      setMode: function (m) { handleAction('mode', m); },
      ui: ui
    };
  }

  if (typeof document !== 'undefined' && document.getElementById) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }
})();
