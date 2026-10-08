/* ==========================================================================
   DFR Handover Console — scenario data
   --------------------------------------------------------------------------
   Pure data. No logic, no DOM. The console (app.js) reads whichever scenario
   window.DFR_SCENARIO_ID names. To add a second scenario, register another
   object with the same shape on window.DFR_SCENARIOS; no UI code changes.

   Everything here is fictional: the city, streets, units, rules and
   procedures are invented for a design exploration, not real police practice.

   Units
   - Map/world coordinates: 1 unit = 2 m (see map.metresPerUnit).
   - Times: seconds, relative to an anchor:
       T  incident card arrives          (scenario clock 0)
       L  drone launched
       A  drone arrived on scene (handover requested)
       H  operator took control
       C  operator's latest garden-detection choice
       P  patrol on scene
       E  operator ended the incident
     An array anchor such as ['P', 'C'] means "whichever of these is later".
   - Optional `when` gates an event or track on state:
       { garden: 'MONITOR' | [..], status: [..], detected: 'D-02' }
   ========================================================================== */
(function () {
  'use strict';

  var scenario = {
    id: 'warehouse-night',
    title: 'Reported break-in at a closed warehouse',
    city: 'Kessmar',
    clockStart: '02:13:58',          // wall clock at T+0
    condenseFactor: 3,               // quiet autonomous stretches run this much faster

    incident: {
      ref: 'KS-26-1008-0413',
      type: 'Burglary, reported in progress',
      priority: 'P2',
      priorityNote: 'Property crime; people possibly on site',
      address: 'Speicherhof Nord, Lagerweg 14',
      district: 'Kessmar-Ostfeld',
      callReceivedS: -46,            // call came in 46 s before the card arrived
      caller: 'Neighbour, Lagerweg 10',
      callerNotes: 'Two people near the loading bay of the closed warehouse next door. ' +
        'Saw torch light, heard metal scraping. Caller is indoors and has not gone outside. ' +
        'Did not see a vehicle.',
      site: [850, 166],
      drone: { id: 'DR-03', dock: 'Dock Ostkai', distanceKm: 1.8, etaS: 120 },
      patrol: { id: 'P-14', etaS: 420, from: 'Revier West' }
    },

    /* Invented programme rules. Referenced by id in the audit trail. */
    rules: {
      'DFR-L2': 'Launch is allowed without a call-taker request when: priority P2 or higher, site within 3 km of the dock, weather within limits, route clear of restricted airspace.',
      'DFR-R1': 'Record the camera from launch until the drone is docked.',
      'DFR-C1': 'On approach, the camera may point at the incident address once within 400 m.',
      'DFR-H1': 'On arrival the drone holds in orbit and asks for an operator. After handover, nothing the system suggests runs until the operator acts.',
      'DFR-H3': 'When the operator ends the incident, the drone returns to its dock on its own.',
      'DFR-P2': 'The system flags, but never resolves, detections inside private property.',
      'AIR-03': 'Keep at least 200 m from the St. Aldric hospital helipad (no-fly zone NFZ-07).'
    },

    launch: {
      rule: 'DFR-L2',
      policySummary: 'P2; 1.8 km from dock (limit 3 km); wind 6 m/s, dry (limit 10 m/s); route clear of NFZ-07 with a 70 m detour.',
      abortWindowS: 10,
      reasons: [
        'Priority P2: property crime, people possibly on site.',
        'Drone ETA 2:00 vs patrol ETA 7:00: about five minutes of view before the first unit arrives.',
        'Site is 1.8 km from Dock Ostkai (limit 3 km).',
        'Wind 6 m/s, dry, good visibility (limit 10 m/s).',
        'Route avoids the St. Aldric helipad no-fly zone (70 m detour).',
        'DR-03 battery 94%: about 22 min on scene.'
      ]
    },

    drone: {
      id: 'DR-03',
      dock: [90, 560],
      batteryStart: 94,
      batteryDrainPerS: 0.07,        // % per second airborne
      cruiseAltM: 60,
      climbS: 8,
      linkStart: 96,
      transitS: 120,                 // launch to arrival
      rtbS: 120,                     // end of incident to docked
      route: [[90, 560], [330, 545], [560, 525], [700, 330], [823, 195]],
      orbit: { cx: 850, cy: 166, r: 40, periodS: 48 }
    },

    patrol: {
      id: 'P-14',
      route: [[-560, 335], [0, 330], [420, 300], [560, 180], [620, 201], [856, 201]],
      arriveAt: 420                  // T+7:00
    },

    /* Thermal feed: world-space view size at zoom 1 (units), height/width ratio. */
    feed: {
      viewWidth: 110,
      aspect: 0.66,
      approachLookAhead: 70,
      siteTarget: [850, 166],
      privacy: {
        area: 'garden12',
        awayTarget: [878, 168],      // camera centre that keeps the garden out of frame
        label: 'Private garden, no. 12'
      }
    },

    map: {
      metresPerUnit: 2,
      views: {
        area: [-10, -10, 1020, 640],
        site: [742, 100, 216, 134]
      },
      river: [[0, 590], [250, 585], [500, 598], [750, 585], [1000, 565], [1000, 640], [0, 640]],
      streets: [
        { name: 'Mühlenkai', w: 10, pts: [[0, 572], [300, 566], [600, 570], [1000, 540]] },
        { name: 'Hafenallee', w: 9, pts: [[0, 470], [380, 462], [1000, 440]] },
        { name: 'Ostring', w: 12, pts: [[250, 640], [300, 470], [420, 300], [560, 180], [640, 60], [660, 0]] },
        { name: 'Kanalstraße', w: 8, pts: [[520, 640], [600, 420], [700, 250], [760, 0]] },
        { name: 'Lagerweg', w: 8, pts: [[560, 180], [620, 201], [1000, 201]] },
        { name: 'Brunnengasse', w: 7, pts: [[0, 330], [420, 300]] },
        { name: 'Feldstraße', w: 7, pts: [[600, 420], [1000, 330]] },
        { name: 'Birkenweg', w: 6, pts: [[768, 0], [768, 201]] },
        { name: 'Nordstraße', w: 7, pts: [[0, 150], [560, 180]] },
        { name: 'Ostfeldweg', w: 6, pts: [[930, 201], [930, 440]] },
        { name: 'Dockstraße', w: 6, pts: [[90, 568], [110, 470]] },
        { name: 'Aldricweg', w: 6, pts: [[440, 462], [440, 432]] }
      ],
      labels: [
        { text: 'Mühlenkai', x: 170, y: 560 },
        { text: 'Hafenallee', x: 120, y: 458 },
        { text: 'Ostring', x: 330, y: 404, rotate: -55 },
        { text: 'Kanalstraße', x: 640, y: 352, rotate: -60 },
        { text: 'Lagerweg', x: 700, y: 216 },
        { text: 'Brunnengasse', x: 160, y: 308 },
        { text: 'Feldstraße', x: 780, y: 368, rotate: -13 },
        { text: 'Nordstraße', x: 240, y: 152 },
        { text: 'River Kess', x: 560, y: 616 }
      ],
      blocks: [
        [20, 20, 90, 60], [130, 20, 80, 50], [230, 30, 100, 70], [350, 20, 70, 60], [440, 40, 80, 60],
        [30, 100, 60, 30], [120, 90, 90, 40], [680, 20, 60, 50], [790, 20, 70, 60], [880, 30, 90, 70],
        [790, 100, 40, 25], [20, 180, 100, 110], [140, 190, 120, 90], [280, 180, 120, 80], [430, 205, 70, 60],
        [30, 350, 110, 90], [160, 350, 100, 90], [280, 320, 60, 50], [600, 240, 70, 60], [500, 320, 60, 80],
        [720, 260, 120, 50], [860, 230, 60, 60], [940, 230, 50, 80], [700, 405, 180, 25], [590, 475, 150, 60],
        [760, 470, 120, 55], [900, 460, 90, 60], [150, 480, 120, 60], [320, 480, 70, 60], [20, 480, 50, 60],
        [905, 165, 18, 20], [940, 120, 50, 60]
      ],
      landmarks: [
        { id: 'hospital', label: 'St. Aldric Hospital', rect: [400, 370, 80, 60] },
        { id: 'dock', label: 'Dock Ostkai · DR-03', rect: [75, 545, 30, 26] }
      ],
      noFly: [
        { id: 'NFZ-07', label: 'NFZ-07 · helipad', cx: 440, cy: 400, r: 100 }
      ],
      site: {
        fence: [822, 128, 76, 64],
        buildings: [
          { id: 'warehouse', label: 'Speicherhof Nord', rect: [835, 140, 50, 32], roof: 0.2 },
          { id: 'house12', label: '12', rect: [800, 170, 14, 16], roof: 0.32 },
          { id: 'house10', label: '10', rect: [778, 172, 16, 14], roof: 0.34 }
        ],
        apron: [842, 172, 30, 12],
        pallets: [864, 175, 5, 4],
        gardens: [
          { id: 'garden12', label: 'Private garden, no. 12', private: true, pts: [[798, 140], [818, 140], [818, 168], [798, 168]] },
          { id: 'garden10', label: 'Garden, no. 10', private: true, pts: [[776, 142], [796, 142], [796, 170], [776, 170]] }
        ],
        trees: [[810, 150.5, 2.4], [781, 150, 3], [790, 160, 2.4]],
        sideGate: [898, 182],
        siteLabel: { text: 'Lagerweg 14', x: 906, y: 124 }
      }
    },

    /* Things the thermal camera can see. Positions in world units.
       base: default position (null = not present unless a track says so).
       wander: small idle movement. tracks: keyframed overrides, gated by `when`. */
    entities: [
      { id: 'veh', kind: 'vehicle', base: [889, 183] },
      { id: 'shutter', kind: 'heatleak', base: [856, 172] },
      { id: 'p1', kind: 'person', base: [853, 179], wander: { a: 1.6, periodS: 17 } },
      { id: 'p2', kind: 'person', base: [861, 177], wander: { a: 0.7, periodS: 23 } },
      {
        id: 'g1', kind: 'person', base: [808, 152], wander: { a: 0.25, periodS: 31 },
        tracks: [
          { when: { garden: 'MONITOR' }, keys: [
            { anchor: 'C', at: 8, x: 808, y: 152 },
            { anchor: 'C', at: 20, x: 808, y: 166 },
            { anchor: 'C', at: 22, x: 808, y: 167, hidden: true }
          ] }
        ]
      },
      { id: 'porch', kind: 'light', base: null, tracks: [
        { when: { garden: 'MONITOR' }, keys: [{ anchor: 'C', at: 19, x: 808, y: 169 }] }
      ] },
      { id: 'car', kind: 'car', base: null, tracks: [
        { keys: [{ anchor: 'P', at: 0, x: 856, y: 201 }] }
      ] },
      { id: 'o1', kind: 'person', base: null, tracks: [
        { keys: [{ anchor: 'P', at: 6, x: 854, y: 198 }, { anchor: 'P', at: 22, x: 851, y: 184 }] }
      ] },
      { id: 'o2', kind: 'person', base: null, tracks: [
        { keys: [{ anchor: 'P', at: 7, x: 858, y: 198 }, { anchor: 'P', at: 24, x: 863, y: 183 }] }
      ] },
      { id: 'o3', kind: 'person', base: null, tracks: [
        { when: { garden: 'FLAGGED' }, keys: [
          { anchor: ['P', 'C'], at: 18, x: 806, y: 199 },
          { anchor: ['P', 'C'], at: 26, x: 796, y: 189 },
          { anchor: ['P', 'C'], at: 34, x: 797, y: 162 },
          { anchor: ['P', 'C'], at: 40, x: 805, y: 155 }
        ] }
      ] }
    ],

    detections: {
      'D-01': { entity: 'veh', kind: 'Vehicle', label: 'Vehicle at side gate, engine warm', size: [7, 4], confidence: 0.88,
        evidence: 'Engine block 41 °C above ambient. Lights off. Parked inside the fence by the side gate.' },
      'D-02': { entity: 'g1', kind: 'Person?', label: 'Person-shaped heat signature, private garden', size: [3.4, 3.4], confidence: 0.41, needsHuman: true, privateArea: 'garden12',
        evidence: 'Upright, about 1.7 m, still for 15 s. Half behind a tree. Could be a resident or one of the reported people.' },
      'D-03': { entity: 'p1', kind: 'Person', label: 'Person at loading bay', size: [3, 3], confidence: 0.72,
        evidence: 'Moving between the bay and the shutter. Small hot spot at hand height, consistent with a torch.' },
      'D-04': { entity: 'p2', kind: 'Person', label: 'Person by shutter', size: [3, 3], confidence: 0.66,
        evidence: 'Mostly still beside the shutter, partly behind a pallet stack.' },
      'D-05': { entity: 'shutter', kind: 'Opening', label: 'Loading-bay shutter partly open', size: [14, 5], confidence: 0.58,
        evidence: 'Warm air escaping in a 0.6 m band at floor level; consistent with a shutter raised about 60 cm.' }
    },

    unknowns: {
      'U-01': 'Whether anyone is inside. The roof blocks thermal imaging.',
      'U-02': 'Whether the vehicle at the side gate belongs to the people at the bay.',
      'U-03': 'Whether the garden figure is a resident or a suspect. The system will not decide.',
      'U-04': 'How many people: caller said two; drone sees two at the bay plus one in the garden.',
      'U-05': 'North and east sides of the building not yet observed.'
    },

    brief: {
      lookingAt: 'Speicherhof Nord, a closed warehouse, from a 60 m orbit: two people at the loading bay, a warm vehicle at the side gate, and one uncertain figure in the garden next door.'
    },

    /* Decisions waiting for the human, most urgent first. Shown from handover. */
    decisions: [
      {
        id: 'DEC-1', urgency: 'Most urgent', requires: { detected: 'D-02' },
        title: 'Figure in a private garden',
        text: 'Suspect or resident? The camera records into the garden while it is in frame.',
        kind: 'garden',
        choices: [
          { choice: 'AWAY', label: 'Point camera away', note: 'Privacy first. The garden is masked and the figure stays unresolved.' },
          { choice: 'MONITOR', label: 'Keep monitoring', note: 'Watch the figure. Recording into the garden continues.' },
          { choice: 'FLAGGED', label: 'Flag to patrol', note: 'P-14 checks the garden in person when it arrives.' }
        ]
      },
      {
        id: 'DEC-2', urgency: 'Next',
        title: 'Share the live feed with P-14?',
        text: 'The unit sees the bay before it arrives. The feed includes the garden while it is in frame.',
        kind: 'share'
      }
    ],

    /* Suggested first actions. Shown from handover; never run on their own. */
    suggestions: [
      { id: 'S-1', text: 'Point the camera at the loading bay, zoom 2×.', action: { type: 'OP_POINT', x: 857, y: 177, label: 'loading bay', zoom: 2 } },
      { id: 'S-2', text: 'Mark the side-gate vehicle as a point for P-14.', action: { type: 'OP_MARK_POI', x: 889, y: 183, label: 'Vehicle at side gate' } },
      { id: 'S-3', text: 'Look at the north side, not yet seen.', action: { type: 'OP_POINT', x: 860, y: 140, label: 'north side of building' } }
    ],

    /* Scripted timeline. System events only; operator events come from clicks.
       brief: '<short text>' puts the entry in the handover brief's "since launch" list. */
    events: [
      { anchor: 'T', at: 3, type: 'policy_check' },
      { anchor: 'T', at: 5, type: 'launch_gate' },

      { anchor: 'L', at: 3, type: 'log', brief: 'Routed around helipad no-fly zone (+70 m)', rule: 'AIR-03',
        action: 'Set route around the St. Aldric helipad no-fly zone (+70 m)',
        reason: 'Direct line crosses NFZ-07 (hospital helipad, 200 m radius).' },
      { anchor: 'L', at: 8, type: 'log',
        action: 'Reached cruise altitude 60 m',
        reason: 'Standard transit altitude for this sector.' },
      { anchor: 'L', at: 20, type: 'log',
        action: 'Loaded site layout for Lagerweg 14',
        reason: 'Building record attached to the incident address.' },
      { anchor: 'L', at: 20, type: 'unknown', id: 'U-01' },
      { anchor: 'L', at: 48, type: 'link', value: 78 },
      { anchor: 'L', at: 52, type: 'link', value: 91 },
      { anchor: 'L', at: 52, type: 'log',
        action: 'Switched data link relay R2 → R4 (78% → 91%)',
        reason: 'Link quality fell below 80% near Kanalstraße.' },
      { anchor: 'L', at: 75, type: 'camera_auto', mode: 'SITE' },
      { anchor: 'L', at: 75, type: 'log', rule: 'DFR-C1',
        action: 'Pointed camera at the incident address',
        reason: 'Within 400 m of the site on approach.' },
      { anchor: 'L', at: 80, type: 'detect', id: 'D-01' },
      { anchor: 'L', at: 80, type: 'unknown', id: 'U-02' },
      { anchor: 'L', at: 95, type: 'detect', id: 'D-02' },
      { anchor: 'L', at: 95, type: 'unknown', id: 'U-03' },
      { anchor: 'L', at: 96, type: 'log', brief: 'Queued garden detection for you; no action', rule: 'DFR-P2',
        action: 'Queued garden detection for the operator; took no action on it',
        reason: 'Low confidence (0.41) and inside private property.' },
      { anchor: 'L', at: 110, type: 'detect', id: 'D-03' },
      { anchor: 'L', at: 110, type: 'detect', id: 'D-04' },
      { anchor: 'L', at: 110, type: 'unknown', id: 'U-04' },
      { anchor: 'L', at: 112, type: 'detect', id: 'D-05' },
      { anchor: 'L', at: 120, type: 'arrive' },
      { anchor: 'A', at: 0, type: 'unknown', id: 'U-05' },

      { anchor: 'T', at: 420, type: 'patrol_on_scene' },

      /* Garden detection: what follows each operator choice */
      { anchor: 'C', at: 4, when: { garden: 'FLAGGED' }, type: 'log',
        action: 'P-14 acknowledged the garden flag',
        reason: 'Unit will check the garden of no. 12 on arrival.' },
      { anchor: ['P', 'C'], at: 40, when: { garden: 'FLAGGED' }, type: 'detect_update', id: 'D-02',
        label: 'Resident, confirmed in person by P-14', confidence: null, verifiedBy: 'P-14',
        evidence: 'Officer spoke to the resident, who had heard the noise and stepped outside.',
        resolve: { id: 'U-03', note: 'Resolved in person by P-14: a resident.' } },
      { anchor: 'C', at: 20, when: { garden: 'MONITOR' }, type: 'log',
        action: 'Garden figure walked to the back door of no. 12; porch light came on',
        reason: 'Observed on the thermal feed while monitoring.' },
      { anchor: 'C', at: 24, when: { garden: 'MONITOR' }, type: 'detect_update', id: 'D-02',
        label: 'Figure in garden: consistent with a resident (unverified)', confidence: 0.63,
        evidence: 'Walked to the back door, porch light switched on, went inside.',
        resolve: { id: 'U-03', note: 'Probably a resident. Not verified.' } },
      { anchor: 'P', at: 1, when: { garden: 'PENDING', detected: 'D-02' }, type: 'log', rule: 'DFR-P2',
        action: 'Garden detection still waiting for an operator decision',
        reason: 'System does not resolve detections in private property; framing unchanged.' },

      /* Patrol on scene */
      { anchor: 'P', at: 26, when: { status: ['ON_SCENE'] }, type: 'detect_update', id: 'D-03',
        label: 'Person at loading bay, stopped by P-14', status: 'With patrol' },
      { anchor: 'P', at: 26, when: { status: ['ON_SCENE'] }, type: 'detect_update', id: 'D-04',
        label: 'Person by shutter, stopped by P-14', status: 'With patrol' },

      { anchor: 'E', at: 120, type: 'docked' }
    ],

    /* Close-out text for each garden outcome. */
    outcomes: {
      AWAY: 'The garden was masked and the figure was never identified. Nobody checked who it was. Recording into the garden stopped when you pointed the camera away.',
      MONITOR: 'You kept watching. The figure walked to the back door of no. 12, switched on the porch light and went inside: probably a resident, not verified. The camera recorded into the private garden the whole time.',
      FLAGGED: 'P-14 checked the garden in person and found a resident who had heard the noise. An officer spent about two minutes on it instead of on the bay.',
      PENDING: 'No decision was taken. The figure stayed in frame, and on the recording, until the drone left.',
      NO_DRONE: 'The drone was not launched, so the figure in the garden was never seen. P-14 handled the scene without an aerial view.'
    }
  };

  window.DFR_SCENARIOS = window.DFR_SCENARIOS || {};
  window.DFR_SCENARIOS[scenario.id] = scenario;
  window.DFR_SCENARIO_ID = window.DFR_SCENARIO_ID || scenario.id;
})();
