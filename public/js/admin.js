/* global L, CR, turf */
(function () {
    "use strict";

    var SNAP_METERS = 3;
    var CURVE_SAMPLES = 20;
    var CURVE_ALPHA = 0.5;
    var HANDLE_COLOR = "#ff3b3b";
    var EDIT_SNAP_METERS = 3;
    var DELETE_POLYGON_STYLE = { color: "#d32f2f", weight: 2, fillColor: "#ffcdd2", fillOpacity: 0.15 };

    /**
     * Bootstraps the admin map with segmented walkways, live bend handles, right-side panel, and walkway edit mode.
     * @returns {Promise<void>}
     */
    async function bootAdmin() {
        const map = CR.initMap("map");
        if (CR.initUtilityDrawer) CR.initUtilityDrawer(map);

        const fc = await CR.fetchFeatures();
        const allFeatures = fc.features || [];
        const featureLayer = CR.createFeaturesLayer(fc)

        const wfc = await CR.fetchWalkways();
        const sanitizedWalkways = sanitizeFeatureCollection(wfc);
        const walkwayFeatures = (sanitizedWalkways.features || []).slice();
        const walkwayLayer = CR.createWalkwaysLayer({ type: "FeatureCollection", features: walkwayFeatures })


        //joe added
        const editableLayers = new L.FeatureGroup().addTo(map);
        featureLayer.eachLayer(l => editableLayers.addLayer(l));
        walkwayLayer.eachLayer(l => editableLayers.addLayer(l));


        //Building inspection logic JN
        const inspector = document.getElementById("feature-inspector");
        const inspectId = document.getElementById("inspect-id");
        const inspectName = document.getElementById("inspect-name");
        const inspectPrefix = document.getElementById("inspect-prefix");
        const inspectNumber = document.getElementById("inspect-number");
        
        let currentEditLayer = null;

        // Open Inspector on Click
        editableLayers.on("click", function (e) {
            // Ignore if we are doing route snapping
            if (window.CR_routingMode) return;

            const layer = e.layer;
            const feature = layer.feature;
            if (!feature || !feature.properties) return;

            // Only open for Buildings/Rooms
            if (feature.geometry.type === "Polygon" || feature.geometry.type === "MultiPolygon") {
                currentEditLayer = layer;
                const p = feature.properties;
                
                inspectId.value = p._id || "";
                inspectName.value = p.name || "";
                inspectPrefix.value = p.prefix || "";
                inspectNumber.value = p.number || "";
                
                inspector.style.display = "block";
            }
        });

        // Save Changes
        document.getElementById("inspect-save")?.addEventListener("click", async () => {
            if (!currentEditLayer) return;

            const feature = currentEditLayer.feature;
            feature.properties.name = inspectName.value.trim();
            feature.properties.prefix = inspectPrefix.value.trim().toUpperCase();
            feature.properties.number = inspectNumber.value.trim();

            const saved = await CR.saveFeature(feature);
            currentEditLayer.feature = saved;
            
            // Keep master array in sync
            const idx = allFeatures.findIndex(f => f.properties._id === saved.properties._id);
            if (idx >= 0) allFeatures[idx] = saved;

            inspector.style.display = "none";
            currentEditLayer = null;
            
            // Optional: Show a toast or console log to confirm
            console.log("Saved Building:", saved.properties.name);
        });

        // Cancel
        document.getElementById("inspect-cancel")?.addEventListener("click", () => {
            inspector.style.display = "none";
            currentEditLayer = null;
        });


        //Joe edited code
        // Persist edits made via Leaflet draw editor
        map.on(L.Draw.Event.EDITED, function (e) {
            const layers = e.layers;
            layers.eachLayer(async function (layer) {
                if (!layer.feature || !layer.feature.properties) return;
        
                const geomType = layer.feature.geometry.type;
        
                if (geomType === "LineString") {
                    // Logic for walkways
                    await persistEditedWalkway(map, layer, walkwayFeatures);
                } else if (geomType === "Polygon" || geomType === "MultiPolygon") {
                    const updatedFeature = layer.toGeoJSON();

                    // Preserve ALL original properties (prefix, name, type, etc.)
                    // Only the geometry has changed — the draw tool shouldn't touch metadata
                    updatedFeature.properties = { ...layer.feature.properties };

                    const saved = await CR.saveFeature(updatedFeature);
                    layer.feature = saved;

                    const idx = allFeatures.findIndex(f => f.properties._id === saved.properties._id);
                    if (idx >= 0) allFeatures[idx] = saved;

                    console.log("Polygon updated and saved to DB:", saved.properties.name);

                }
            });
        });
        // Handle the Leaflet Draw DELETED event to persist deletions
        map.on(L.Draw.Event.DELETED, function (e) {
            e.layers.eachLayer(async function (layer) {
                if (!layer.feature || !layer.feature.properties) return;
                const id = layer.feature.properties._id;
                if (!id) return;

                const geomType = layer.feature.geometry && layer.feature.geometry.type;

                if (geomType === "LineString") {
                    // Walkway deletion
                    await CR.deleteWalkway(id);
                    const idx = walkwayFeatures.findIndex(f => f.properties && f.properties._id === id);
                    if (idx >= 0) walkwayFeatures.splice(idx, 1);
                } else {
                    // Building / room / entrance / parking deletion
                    await CR.deleteFeature(id);
                    const idx = allFeatures.findIndex(f => f.properties && f.properties._id === id);
                    if (idx >= 0) allFeatures.splice(idx, 1);
                }

                // Also remove from featureLayer so the polygon actually disappears
                // (layers are shared between featureLayer and editableLayers)
                featureLayer.eachLayer(function (fl) {
                    if (fl.feature && fl.feature.properties && fl.feature.properties._id === id) {
                        featureLayer.removeLayer(fl);
                    }
                });
            });
        });
        window.CR.onMenuAction = function (action) {
            // Test buttons for navigation point selection JN
            if (action === "set-start-nav") {
                window.CR_routingMode = "start";
                map._container.style.cursor = "crosshair";
                console.log("Routing Mode: Click a building or entrance to set the START point.");
                return;
            }
            if (action === "set-end-nav") {
                window.CR_routingMode = "end";
                map._container.style.cursor = "crosshair";
                console.log("Routing Mode: Click a building or entrance to set the END point.");
                return;
            }

            if (action === "fit-to-campus") {
                try {
                    const group = L.featureGroup([featureLayer, walkwayLayer]);
                    const b = group.getBounds();
                    if (b.isValid()) map.fitBounds(b, { padding: [40, 40] });
                } catch (e) {
                    // eslint-disable-next-line no-console
                    console.warn("Fit to campus failed", e);
                }
                return;
            }
            if (action === "download-data") {
                try {
                    const combined = {
                        features: allFeatures,
                        walkways: walkwayFeatures
                    };
                    const blob = new Blob([JSON.stringify(combined, null, 2)], { type: "application/json" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = "campus-data.json";
                    a.click();
                    URL.revokeObjectURL(url);
                } catch (e) {
                    // eslint-disable-next-line no-console
                    console.warn("Download failed", e);
                }
                return;
            }
            if (action === "help") {
                alert("Tips:\n- Use draw controls (top-left) to add/edit features.\n- Shortcuts: B building, E entrance, S stairwell, R room, W walkway, P parking.\n- Use the gear for settings.");
            }
            if (action === "bulk-select") {
                beginBoxSelect();
                alert("Drag a box to select walkway segments. Press Delete to remove them.");
            }
            if (action === "polygon-delete") {
                startPolygonDelete();
            }
            if (action === "delete-selected") {
                if (!multiSelection.size) {
                    alert("No walkway segments selected.");
                    return;
                }
                deleteSelectedWalkways(walkwayLayer, multiSelection);
            }
            //added for network audit feature JN
            if (action === "audit-network") {
                auditNetworkConnectivity(map, walkwayFeatures, walkwayLayer);
                return;
            }
        };

        let nodes = buildNodeIndex(walkwayFeatures, allFeatures);
        let selectedWalkwayLayer = null;
        let segmentHandles = [];
        let editMode = false;
        let boxState = null;
        let multiSelection = new Set();
        let multiSelectMode = false;
        let deletePolygonDraw = null;

        //Joe edited
        const drawControl = new L.Control.Draw({
            position: "topleft",
            draw: {
                polygon: {
                    allowIntersection: false,
                    showArea: true,
                    shapeOptions: { color: "rgba(142,0,28,0.9)" }
                },
                polyline: { shapeOptions: { color: "rgb(16,124,111)", weight: 3 } },
                rectangle: false,
                circle: false,
                circlemarker: false,
                marker: { icon: new L.Icon.Default() }
            },
            edit: { 
                featureGroup: editableLayers, // Use the dedicated group
                poly: {
                    allowIntersection: false },//prevents polgyons from overlapping 
                remove: true
            }
        });
        map.addControl(drawControl);

        //joe added
        // admin.js - Add these near your other map.on listeners
        // 1. When editing starts
        map.on(L.Draw.Event.EDITSTART, function () {
            editableLayers.eachLayer(l => {
            // Disable popups so they don't block the mouse
                if (l.closePopup) l.closePopup().unbindPopup();

                // Enable the dragging plugin for the polygon body
                if (l.dragging) l.dragging.enable();

                // Change style to show it's "grabbable"
                if (l.setStyle) l.setStyle({ fillOpacity: 0.5, weight: 4 });

                // Disable map panning only when hovering over a shape
                l.on('mouseover', () => map.dragging.disable());
                l.on('mouseout', () => map.dragging.enable());
            });
            console.log("Edit Mode: Handles active, body dragging enabled.");
        });

        // 2. When editing stops (Save or Cancel)
        map.on(L.Draw.Event.EDITSTOP, function () {
            editableLayers.eachLayer(l => {
             // Restore popups
                if (window.CR && CR._bindPopupForFeature) {
                    CR._bindPopupForFeature(l.feature, l);
                }
        
                // Remove temporary hover listeners
                l.off('mouseover');
                l.off('mouseout');

                // Disable dragging plugin
                if (l.dragging) l.dragging.disable();

                // Reset style
                if (l.setStyle) l.setStyle({ fillOpacity: 0.25, weight: 2 });
            });

            // FORCE: Ensure map panning and cursor are restored
            map.dragging.enable();
            map._container.style.cursor = "";
            console.log("Edit Mode: Map restored to normal.");
        });

   

        //Joe added
        map.on(L.Draw.Event.EDITSTOP, function () {
            map._container.style.cursor = ""; 
            console.log("Editor closed/Cancelled.");
        });

        await normalizeWalkways(map, walkwayLayer, walkwayFeatures);

        walkwayLayer.eachLayer(function (l) {
            attachWalkway(map, walkwayLayer, l, function (layer) {
                selectedWalkwayLayer = setSelectedWalkway(selectedWalkwayLayer, layer);
                updateWalkwayPanel(map, layer, walkwayLayer, function (nl) { selectedWalkwayLayer = nl; });
                clearSegmentHandles(segmentHandles);
                segmentHandles = showSegmentHandles(map, layer, CURVE_SAMPLES, CURVE_ALPHA, function (newGeom, newControl, props) { return persistBend(layer, newGeom, newControl, props); });
            });
        });

        // Listener for selecting Buildings/Entrances for navigation JN
        // ADD NAVIGATION CLICK LISTENER HERE
        editableLayers.on("click", function (e) {
            if (!window.CR_routingMode) return;

            const layer = e.layer;
            const feature = layer.feature;
            if (!feature || !feature.properties) return;

            // 1. Get the center point (if building) or exact point (if entrance)
            const targetLatLng = layer.getBounds ? layer.getBounds().getCenter() : layer.getLatLng();
            const coord = [targetLatLng.lng, targetLatLng.lat];

            // 2. Snap it to the nearest walkway node
            const snapped = snapCoord(map, coord, nodes, SNAP_METERS);
            const snappedLatLng = L.latLng(snapped[1], snapped[0]);

            // 3. Drop a temporary marker so you can see it worked
            const markerColor = window.CR_routingMode === "start" ? "#2e7d32" : "#c62828";
            const tempMarker = L.circleMarker(snappedLatLng, {
                radius: 8,
                fillColor: markerColor,
                color: "#fff",
                weight: 2,
                fillOpacity: 1
            }).addTo(map);

            console.log(`${window.CR_routingMode.toUpperCase()} point set at:`, snapped);

            // 4. Cleanup: Exit routing mode
            window.CR_routingMode = null;
            map._container.style.cursor = "";
            
            // Auto-remove the marker after 5 seconds
            setTimeout(() => map.removeLayer(tempMarker), 5000);
        });

        L.DomEvent.on(document, "keydown", async function (e) {
            if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
            if (e.key === "b" || e.key === "B") startDraw("building");
            if (e.key === "r" || e.key === "R") startDraw("room");
            if (e.key === "e" || e.key === "E") startDraw("entrance");
            if (e.key === "s" || e.key === "S") startDraw("stairwell");
            if (e.key === "w" || e.key === "W") startDraw("walkway");
            if (e.key === "p" || e.key === "P") startDraw("parking");
            if (e.key === "x" || e.key === "X") toggleWalkwayEditMode();
            if (e.key === "m" || e.key === "M") {
                beginBoxSelect(); // drag-to-select
            }
            if ((e.key === "Delete" || e.key === "Backspace") && (editMode || multiSelection.size)) deleteSelectedWalkways(walkwayLayer, multiSelection);
        });

        /**
         * Starts an appropriate drawing tool by type.
         * @param {"building"|"room"|"entrance"|"stairwell"|"parking"|"walkway"} type
         * @returns {void}
         */
        function startDraw(type) {
            let drawer;
            if (type === "walkway") drawer = new L.Draw.Polyline(map, drawControl.options.draw.polyline);
            else if (type === "building" || type === "room" || type === "parking")
                drawer = new L.Draw.Polygon(map, drawControl.options.draw.polygon);
            else drawer = new L.Draw.Marker(map, drawControl.options.draw.marker);

            drawer.enable();
            map.once(L.Draw.Event.CREATED, async function (evt) {
                await handleCreated(evt.layer, type);
                nodes = buildNodeIndex(walkwayFeatures, allFeatures);
            });
        }

        /**
         * Snap / magnet a walkway polyline so it connects cleanly to the network:
         *  - Every vertex snaps to the nearest walkway segment or node within SNAP_METERS.
         *  - If start and end are nearly the same, we close the loop.
         * @param {L.Map} mapInst
         * @param {Array<[number,number]>} coords raw [lng,lat] polyline
         * @param {GeoJSON.Feature[]} walkways existing walkway features
         * @param {Array<[number,number]>} nodes existing graph nodes (entrances, endpoints, etc.)
         * @param {number} snapMeters max snap distance in meters
         * @returns {Array<[number,number]>} adjusted coordinates
         */
        function magnetizeWalkwayPolyline(mapInst, coords, walkways, nodes, snapMeters) {
            if (!coords || coords.length < 2) return coords;

            function snapToNodes(c) {
                var p = L.latLng(c[1], c[0]);
                var best = null;
                for (var i = 0; i < nodes.length; i++) {
                    var q = L.latLng(nodes[i][1], nodes[i][0]);
                    var d = mapInst.distance(p, q);
                    if (d <= snapMeters && (!best || d < best.d)) best = { d: d, c: nodes[i] };
                }
                return best ? best.c : c;
            }

            function snapToWalkwaySegments(c) {
                const clickLL = L.latLng(c[1], c[0]);
                const clickPt = mapInst.project(clickLL);
                let best = null;

                walkways.forEach(function (f) {
                    if (!f.geometry || f.geometry.type !== "LineString") return;
                    const segCoords = f.geometry.coordinates || [];
                    if (segCoords.length < 2) return;

                    for (let i = 0; i < segCoords.length - 1; i++) {
                        const A = segCoords[i];
                        const B = segCoords[i + 1];
                        const aLL = L.latLng(A[1], A[0]);
                        const bLL = L.latLng(B[1], B[0]);
                        const aPt = mapInst.project(aLL);
                        const bPt = mapInst.project(bLL);

                        const vx = bPt.x - aPt.x;
                        const vy = bPt.y - aPt.y;
                        const wx = clickPt.x - aPt.x;
                        const wy = clickPt.y - aPt.y;

                        const vv = vx * vx + vy * vy || 1e-12;
                        let t = (vx * wx + vy * wy) / vv;
                        if (t < 0) t = 0;
                        if (t > 1) t = 1;

                        const projX = aPt.x + t * vx;
                        const projY = aPt.y + t * vy;
                        const projLL = mapInst.unproject(L.point(projX, projY));

                        const dist = mapInst.distance(clickLL, projLL);
                        if (dist <= snapMeters && (!best || dist < best.dist)) {
                            best = {
                                dist: dist,
                                coord: [projLL.lng, projLL.lat]
                            };
                        }
                    }
                });

                return best ? best.coord : c;
            }

            // Step 1: snap each vertex
            const out = coords.map(function (c) {
                let snapped = snapToWalkwaySegments(c);
                if (snapped === c) snapped = snapToNodes(c);
                return snapped;
            });

            // Step 2: auto-close loop if start/end are almost the same
            if (out.length > 2) {
                const firstLL = L.latLng(out[0][1], out[0][0]);
                const lastLL = L.latLng(out[out.length - 1][1], out[out.length - 1][0]);
                if (mapInst.distance(firstLL, lastLL) <= snapMeters) {
                    out[out.length - 1] = out[0].slice();
                }
            }

            // Step 3: remove duplicate / near-duplicate vertices
            const cleaned = [];
            for (let i = 0; i < out.length; i++) {
                const c = out[i];
                if (cleaned.length === 0) {
                    cleaned.push(c);
                } else {
                    const prev = cleaned[cleaned.length - 1];
                    const d = mapInst.distance(
                        L.latLng(prev[1], prev[0]),
                        L.latLng(c[1], c[0])
                    );
                    if (d > 0.1) cleaned.push(c);
                }
            }

            return cleaned.length >= 2 ? cleaned : out;
        }


        /**
         * Handles new geometry creation by saving to the correct store with walkway segmentation.
         * @param {L.Layer} layer
         * @param {string} type
         * @returns {Promise<void>}
         */
        async function handleCreated(layer, type) {
            const gj = layer.toGeoJSON();

            if (type === "walkway") {
                // Raw coordinates from the drawn line
                let coords = (gj.geometry && gj.geometry.coordinates)
                    ? gj.geometry.coordinates.slice()
                    : [];
                if (coords.length < 2) return;

                // New: magnetize to existing walkways + nodes
                coords = magnetizeWalkwayPolyline(map, coords, walkwayFeatures, nodes, SNAP_METERS);
                if (coords.length < 2) return;

                // Single straight segment
                if (coords.length === 2) {
                    const name = prompt("Walkway name or code (optional):", "") || undefined;
                    const props = {
                        type: "walkway",
                        name: name,
                        curved: false,
                        control: coords.slice(),
                        segmented: true
                    };

                    const saved = await CR.saveWalkway({
                        type: "Feature",
                        geometry: {type: "LineString", coordinates: coords},
                        properties: props
                    });

                    walkwayFeatures.push(saved);

                addAndAttachWalkway(saved);
            } else {
                    // Multi-vertex walkway: split into segments so each bend is editable
                    const baseName = prompt("Walkway base name/code (optional, applied to segments):", "") || undefined;
                    const segs = splitIntoSegments(coords).map(function (pair, i) {
                        return {
                            type: "Feature",
                            geometry: {type: "LineString", coordinates: pair},
                            properties: {
                                type: "walkway",
                                name: baseName,
                                curved: false,
                                control: pair.slice(),
                                segmented: true,
                                segmentIndex: i
                            }
                        };
                    });

                    for (const f of segs) {
                        const saved = await CR.saveWalkway(f);
                        walkwayFeatures.push(saved);

                        addAndAttachWalkway(saved);
                    }
                }
            }

            if (type === "entrance") {
                const auto = autoNameEntrance(gj, allFeatures);
                const name = prompt("Entrance name (auto-suggested)", auto.suggestedName) || auto.suggestedName;
                const props = { type: "entrance", name: name, buildingId: auto.buildingId || undefined, direction: auto.direction || undefined };
                const saved = await CR.saveFeature({ type: "Feature", geometry: gj.geometry, properties: props });
                allFeatures.push(saved);
                L.geoJSON(saved, {
                    pointToLayer: function (_f, latlng) { return L.marker(latlng); },
                    onEachFeature: function (f, l) { CR._bindPopupForFeature(f, l); }
                }).addTo(featureLayer);
                return;
            }

            if (type === "parking") {
                const name = prompt("Parking lot code (e.g., P2):", "") || undefined;
                await addFeature(gj, { type: "parking", name: name });
                return;
            }

            if (type === "room") {
                const number = prompt("Room number:", "") || undefined;
                const buildingId = prompt("Building ID (optional):", "") || undefined;
                const name = prompt("Room name (optional):", "") || undefined;
                await addFeature(gj, { type: "room", number: number, name: name, buildingId: buildingId });
                return;
            }

            if (type === "stairwell") {
                const buildingId = prompt("Building ID (optional):", "") || undefined;
                const name = prompt("Stairwell name (optional):", "") || undefined;
                await addFeature(gj, { type: "stairwell", name: name, buildingId: buildingId });
                return;
            }

            if (type === "building") {
                const name = prompt("Building name:", "") || "Building";
                const short = prompt("Building prefix/short code (e.g., HU):", "") || undefined;
                await addFeature(gj, { type: "building", name: name, prefix: short });
            }
        }

        /**
         * Adds a campus feature via /api/features and displays it.
         * @param {GeoJSON.Feature} gj
         * @param {Object} properties
         * @returns {Promise<void>}
         */
        async function addFeature(gj, properties) {
            const saved = await CR.saveFeature({ type: "Feature", geometry: gj.geometry, properties: properties });
            allFeatures.push(saved);
            L.geoJSON(saved, {
                style: function (f) { return CR._styleForFeature(f); },
                pointToLayer: function (_f, latlng) { return L.marker(latlng); },
                onEachFeature: function (f, l) { CR._bindPopupForFeature(f, l); }
            }).addTo(featureLayer);
        }

        /**
         * Normalizes loaded walkways so each feature is a single two-point segment.
         * @param {L.Map} mapInst
         * @param {L.GeoJSON} wl
         * @param {GeoJSON.Feature[]} store
         * @returns {Promise<void>}
         */
        async function normalizeWalkways(mapInst, wl, store) {
            const originals = wl.getLayers().slice();
            for (const layer of originals) {
                const f = layer.feature;
                if (!f || f.geometry.type !== "LineString") continue;
                const coords = f.geometry.coordinates || [];
                if (coords.length <= 2) continue;
                const id = f.properties && f.properties._id;
                const baseName = f.properties && f.properties.name;
                const segs = splitIntoSegments(coords).map(function (pair, i) {
                    return {
                        type: "Feature",
                        geometry: { type: "LineString", coordinates: pair },
                        properties: { type: "walkway", name: baseName, curved: false, control: pair.slice(), segmented: true, segmentIndex: i }
                    };
                });
                for (const seg of segs) {
                    const saved = await CR.saveWalkway(seg);
                    store.push(saved);
                    addAndAttachWalkway(saved);
                }
                if (id) {
                    await CR.deleteWalkway(id);
                    wl.removeLayer(layer);
                }
            }
        }

        function addAndAttachWalkway(savedFeature) {
            const g = L.geoJSON(savedFeature, {
                style: function () { return { color: "rgb(16,124,111)", weight: 3 }; }
            }).addTo(walkwayLayer);

            g.eachLayer(function (ll) {
                attachWalkway(map, walkwayLayer, ll, function (sel) {
                    selectedWalkwayLayer = setSelectedWalkway(selectedWalkwayLayer, sel);
                    updateWalkwayPanel(map, sel, walkwayLayer, function (nl) { selectedWalkwayLayer = nl; });
                    clearSegmentHandles(segmentHandles);
                    segmentHandles = showSegmentHandles(
                        map,
                        sel,
                        CURVE_SAMPLES,
                        CURVE_ALPHA,
                        function (newGeom, newControl, props2) {
                            return persistBend(sel, newGeom, newControl, props2);
                        }
                    );
                    refreshSelectionStyles(walkwayLayer, multiSelection);
                });
            });
        }

        /**
         * Persists a per-segment bend for the active layer.
         * @param {L.Layer} layer
         * @param {Array<[number,number]>} newGeom
         * @param {Array<[number,number]>} newControl
         * @param {Object} props
         * @returns {Promise<void>}
         */
        async function persistBend(layer, newGeom, newControl, props) {
            const baseProps = layer.feature.properties || {};
            const updated = {
                type: "Feature",
                geometry: { type: "LineString", coordinates: newGeom },
                properties: Object.assign({}, baseProps, props || {}, { curved: true, control: newControl, segmented: true, _id: baseProps._id })
            };
            const saved = await CR.saveWalkway(updated);
            layer.feature = saved;
            layer.setLatLngs(newGeom.map(function (c) { return [c[1], c[0]]; }));
            updateWalkwayPanel(map, layer, walkwayLayer, function () {});
        }

        /**
         * Attaches selection behavior to a walkway layer.
         * @param {L.Map} mapInst
         * @param {L.GeoJSON} wl
         * @param {L.Layer} layer
         * @param {(layer:L.Layer)=>void} onSelect
         * @returns {void}
         */
        function attachWalkway(mapInst, wl, layer, onSelect) {
            layer.on("click", function (e) {
                const id = getWalkwayId(layer);
                const multiToggle = multiSelectMode || (e.originalEvent && (e.originalEvent.metaKey || e.originalEvent.ctrlKey));
                if (multiToggle && id) {
                    if (multiSelection.has(id)) {
                        multiSelection.delete(id);
                    } else {
                        multiSelection.add(id);
                    }
                    refreshSelectionStyles(wl, multiSelection);
                    return;
                }
                // single select
                onSelect(layer);
                refreshSelectionStyles(wl, multiSelection, layer);
            });
        }

        /**
         * Highlights next walkway as selected and unhighlights previous.
         * @param {L.Layer|null} prev
         * @param {L.Layer|null} next
         * @returns {L.Layer|null}
         */
        function setSelectedWalkway(prev, next) {
            if (prev && prev.setStyle) prev.setStyle({ weight: 3, opacity: 1.0 });
            const sel = next || null;
            if (sel && sel.setStyle) sel.setStyle({ weight: 5, opacity: 1.0 });
            return sel;
        }
        function getWalkwayId(layer) {
            return layer && layer.feature && layer.feature.properties ? layer.feature.properties._id : null;
        }
        function refreshSelectionStyles(wl, selection, single) {
            wl.eachLayer(function (l) {
                const id = getWalkwayId(l);
                const isSel = selection && selection.has(id);
                if (l.setStyle) {
                    l.setStyle({ weight: isSel || l === single ? 5 : 3, color: isSel ? "#0e6f64" : "rgb(16,124,111)", opacity: 1 });
                }
            });
        }

        /**
         * Clears all existing per-segment drag handles.
         * @param {Array<{index:number,handle:L.CircleMarker,off:Function}>} handles
         * @returns {void}
         */
        function clearSegmentHandles(handles) {
            (handles || []).forEach(function (h) {
                if (h.off) h.off();
                h.handle.remove();
            });
        }

        /**
         * Shows draggable midpoints for each segment with live smooth preview and returns the created handles.
         * @param {L.Map} mapInst
         * @param {L.Layer} layer
         * @param {number} samples
         * @param {number} alpha
         * @param {(geom:Array<[number,number]>, control:Array<[number,number]>, props:Object)=>Promise<void>} onCommit
         * @returns {Array<{index:number,handle:L.CircleMarker,off:Function}>}
         */
        function showSegmentHandles(mapInst, layer, samples, alpha, onCommit) {
            const res = [];
            if (!layer || !layer.feature || layer.feature.geometry.type !== "LineString") return res;

            const f = layer.feature;
            const control = (f.properties && Array.isArray(f.properties.control))
                ? f.properties.control.slice()
                : f.geometry.coordinates.slice();
            if (control.length < 2) return res;

            const segments = splitIntoSegments(control);
            for (let i = 0; i < segments.length; i++) {
                const seg = segments[i];
                const A = seg[0], B = seg[1];
                const mid = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];

                const handle = L.circleMarker([mid[1], mid[0]], {
                    radius: 6,
                    color: HANDLE_COLOR,
                    weight: 2,
                    fillColor: HANDLE_COLOR,
                    fillOpacity: 0.9,
                    pane: "markerPane",
                    bubblingMouseEvents: false
                }).addTo(mapInst);

                let dragging = false;
                let moveFn = null;
                let upFn = null;

                handle.on("mousedown", function () {
                    dragging = true;
                    mapInst.dragging.disable();
                });

                moveFn = function (e) {
                    if (!dragging) return;
                    handle.setLatLng(e.latlng);
                    const bend = [e.latlng.lng, e.latlng.lat];
                    const preview = replaceSegmentWithLocalCurve(control, i, bend, samples, alpha);
                    layer.setLatLngs(preview.map(function (c) { return [c[1], c[0]]; }));
                };

                upFn = async function () {
                    if (!dragging) return;
                    dragging = false;
                    mapInst.dragging.enable();
                    const bendLl = handle.getLatLng();
                    const bend = [bendLl.lng, bendLl.lat];
                    const newGeom = replaceSegmentWithLocalCurve(control, i, bend, samples, alpha);
                    const newControl = updateControlForSegment(control, i, bend);
                    await onCommit(newGeom, newControl, {});
                };

                mapInst.on("mousemove", moveFn);
                mapInst.on("mouseup", upFn);

                res.push({
                    index: i,
                    handle: handle,
                    off: function () {
                        mapInst.off("mousemove", moveFn);
                        mapInst.off("mouseup", upFn);
                    }
                });
            }
            return res;
        }

        /**
         * Updates the right-side context panel for the given walkway.
         * @param {L.Map} mapInst
         * @param {L.Layer} layer
         * @param {L.GeoJSON} wl
         * @param {(layer:L.Layer|null)=>void} setSel
         * @returns {void}
         */
        function updateWalkwayPanel(mapInst, layer, wl, setSel) {
            // Simplified: remove legacy overlay controls to avoid conflicts.
            const panel = document.getElementById("walkway-panel");
            if (panel) panel.remove();
            const editBar = document.getElementById("walkway-editbar");
            if (editBar) editBar.remove();
        }

        /**
         * Toggles walkway edit mode with drag-to-select rectangle and bulk actions.
         * @returns {void}
         */
        function toggleWalkwayEditMode() {
            editMode = !editMode;
            updateWalkwayPanel(map, selectedWalkwayLayer || { feature: { properties: {} } }, walkwayLayer, function () {});
            if (editMode) beginBoxSelect();
            else endBoxSelect();
        }

        /**
         * Begins box selection interaction and initializes handlers.
         * @returns {void}
         */
        function beginBoxSelect() {
            boxState = { start: null, rect: null, mask: null };
            map._container.style.cursor = "crosshair";
            map.on("mousedown", onBoxMouseDown);
            multiSelectMode = true;
        }

        /**
         * Ends box selection interaction and cleans up handlers and overlays.
         * @returns {void}
         */
        function endBoxSelect() {
            map._container.style.cursor = "";
            map.off("mousedown", onBoxMouseDown);
            map.off("mousemove", onBoxMouseMove);
            map.off("mouseup", onBoxMouseUp);
            if (boxState && boxState.rect) { boxState.rect.remove(); }
            if (boxState && boxState.mask) { boxState.mask.remove(); }
            boxState = null;
            multiSelectMode = false;
        }

        /**
         * Handles mousedown to start drawing the selection rectangle.
         * @param {MouseEvent} e
         * @returns {void}
         */
        function onBoxMouseDown(e) {
            if (!editMode) return;
            const latlng = map.mouseEventToLatLng(e.originalEvent || e);
            boxState.start = latlng;
            map.on("mousemove", onBoxMouseMove);
            map.on("mouseup", onBoxMouseUp);
        }

        /**
         * Handles mousemove to update the selection rectangle.
         * @param {MouseEvent} e
         * @returns {void}
         */
        function onBoxMouseMove(e) {
            if (!editMode || !boxState || !boxState.start) return;
            const ll = map.mouseEventToLatLng(e.originalEvent || e);
            const bounds = L.latLngBounds(boxState.start, ll);
            if (!boxState.rect) {
                boxState.rect = L.rectangle(bounds, { color: "#1976d2", weight: 1, fillColor: "#1976d2", fillOpacity: 0.1, interactive: false }).addTo(map);
            } else {
                boxState.rect.setBounds(bounds);
            }
        }

        /**
         * Handles mouseup to finalize selection and compute majority-in-box membership, updating bulk selection set and panel.
         * @returns {void}
         */
        function onBoxMouseUp() {
            if (!editMode || !boxState || !boxState.rect) return;
            const bounds = boxState.rect.getBounds();
            selectWalkwaysInRect(walkwayLayer, bounds, multiSelection);
            map.off("mousemove", onBoxMouseMove);
            map.off("mouseup", onBoxMouseUp);
            if (boxState.rect) { boxState.rect.remove(); boxState.rect = null; }
            refreshSelectionStyles(walkwayLayer, multiSelection);
        }

        /**
         * Selects walkways whose majority length lies within the given bounds and toggles their highlight.
         * @param {L.GeoJSON} wl
         * @param {L.LatLngBounds} bounds
         * @param {Set<string>} selection
         * @returns {void}
         */
        function selectWalkwaysInRect(wl, bounds, selection) {
            const poly = turf.bboxPolygon([bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()]);
            wl.eachLayer(function (layer) {
                if (!layer.feature || layer.feature.geometry.type !== "LineString") return;
                const id = layer.feature.properties && layer.feature.properties._id;
                if (!id) return;
                const insideRatio = lengthInsideRect(layer.feature, poly);
                if (insideRatio >= 0.5) {
                    selection.add(id);
                }
            });
        }

        /**
         * Launch a polygon draw to delete enclosed walkway segments.
         */
        function startPolygonDelete() {
            endBoxSelect();
            if (deletePolygonDraw) deletePolygonDraw.disable();
            deletePolygonDraw = new L.Draw.Polygon(map, { shapeOptions: DELETE_POLYGON_STYLE, showArea: false, allowIntersection: true });
            deletePolygonDraw.enable();
            map.once(L.Draw.Event.CREATED, async function (evt) {
                const polyLayer = evt.layer;
                const poly = polyLayer.toGeoJSON();
                deleteWalkwaysInPolygon(walkwayLayer, walkwayFeatures, poly);
                map.removeLayer(polyLayer);
            });
        }

        /**
         * Remove walkway segments fully inside a polygon.
         * @param {L.GeoJSON} wl
         * @param {GeoJSON.Feature[]} store
         * @param {GeoJSON.Feature} polygon
         */
        async function deleteWalkwaysInPolygon(wl, store, polygon) {
            const toRemove = [];
            wl.eachLayer(function (l) {
                const f = l.feature;
                if (!f || f.geometry.type !== "LineString") return;
                const id = f.properties && f.properties._id;
                if (!id) return;
                let inside = false;
                try {
                    inside = turf.booleanWithin(f, polygon);
                } catch (_) { inside = false; }
                if (inside) toRemove.push({ layer: l, id: id });
            });

            for (const item of toRemove) {
                await CR.deleteWalkway(item.id);
                wl.removeLayer(item.layer);
                const idx = store.findIndex(function (f) { return f.properties && f.properties._id === item.id; });
                if (idx >= 0) store.splice(idx, 1);
                multiSelection.delete(item.id);
            }
            refreshSelectionStyles(wl, multiSelection);
        }

        /**
         * Computes the ratio of a line's length that lies within a rectangle polygon.
         * @param {GeoJSON.Feature<GeoJSON.LineString>} feature
         * @param {GeoJSON.Feature<GeoJSON.Polygon>} rectPoly
         * @returns {number}
         */
        function lengthInsideRect(feature, rectPoly) {
            try {
                const line = feature;
                const clipped = turf.lineSplit(line, rectPoly);
                let inside = 0;
                for (let i = 0; i < clipped.features.length; i++) {
                    const seg = clipped.features[i];
                    const mid = seg.geometry.coordinates[Math.floor(seg.geometry.coordinates.length / 2)];
                    if (turf.booleanPointInPolygon(turf.point(mid), rectPoly)) {
                        inside += turf.length(seg, { units: "meters" });
                    }
                }
                const total = turf.length(line, { units: "meters" }) || 0.000001;
                return Math.min(1, Math.max(0, inside / total));
            } catch (_) {
                return 0;
            }
        }

        /**
         * Deletes all currently selected walkways and clears the selection set.
         * @param {L.GeoJSON} wl
         * @param {Set<string>} selection
         * @returns {Promise<void>}
         */
        async function deleteSelectedWalkways(wl, selection) {
            const ids = Array.from(selection);
            for (const id of ids) {
                await CR.deleteWalkway(id);
            }
            const toRemove = [];
            wl.eachLayer(function (l) {
                const id = l.feature && l.feature.properties && l.feature.properties._id;
                if (id && selection.has(id)) toRemove.push(l);
            });
            toRemove.forEach(function (l) { wl.removeLayer(l); });
            selection.clear();
            refreshSelectionStyles(wl, selection);
            updateWalkwayPanel(map, selectedWalkwayLayer || { feature: { properties: {} } }, wl, function () {});
        }

        /**
         * Builds a node array used for snapping: walkway endpoints + entrances/exits.
         * @param {GeoJSON.Feature[]} walkways
         * @param {GeoJSON.Feature[]} features
         * @returns {Array<[number, number]>}
         */
        function buildNodeIndex(walkways, features) {
            var nodes = [];

            walkways.forEach(function (f) {
                if (f.geometry && f.geometry.type === "LineString") {
                    var coords = f.geometry.coordinates;
                    if (coords.length) {
                        nodes.push(coords[0]);
                        nodes.push(coords[coords.length - 1]);
                    }
                }
            });

            features.forEach(function (f) {
                if (!f.properties) return;
                if ((f.properties.type === "entrance" || f.properties.type === "exit") && f.geometry && f.geometry.type === "Point") {
                    nodes.push(f.geometry.coordinates);
                }
            });

            return nodes;
        }

        /**
         * Snaps a line's endpoints to nearest existing node if within threshold.
         * @param {L.Map} mapInst
         * @param {GeoJSON.Feature} line
         * @param {Array<[number,number]>} nodes
         * @param {number} meters
         * @returns {GeoJSON.Feature}
         */
        function snapLineEndpoints(mapInst, line, nodes, meters) {
            if (!line.geometry || line.geometry.type !== "LineString") return line;
            var coords = line.geometry.coordinates.slice();
            if (coords.length < 2) return line;

            coords[0] = snapCoord(mapInst, coords[0], nodes, meters);
            coords[coords.length - 1] = snapCoord(mapInst, coords[coords.length - 1], nodes, meters);

            return { type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties: line.properties || {} };
        }

        /**
         * Snaps a single [lng,lat] coordinate to the nearest node within meters.
         * @param {L.Map} mapInst
         * @param {[number,number]} coord
         * @param {Array<[number,number]>} nodes
         * @param {number} meters
         * @returns {[number,number]}
         */
        function snapCoord(mapInst, coord, nodes, meters) {
            var p = L.latLng(coord[1], coord[0]);
            var best = null;
            for (var i = 0; i < nodes.length; i++) {
                var q = L.latLng(nodes[i][1], nodes[i][0]);
                var d = mapInst.distance(p, q);
                if (d <= meters && (!best || d < best.d)) best = { d: d, c: nodes[i] };
            }
            return best ? best.c : coord;
        }

        /**
         * Magnetizes a walkway polyline:
         *  - Each vertex snaps to the nearest walkway segment or node within snapMeters.
         *  - If start/end are close, auto-closes the loop.
         */
        function magnetizeWalkwayPolyline(mapInst, coords, walkways, nodes, snapMeters) {
            if (!coords || coords.length < 2) return coords;

            function snapToNodes(c) {
                var p = L.latLng(c[1], c[0]);
                var best = null;
                for (var i = 0; i < nodes.length; i++) {
                    var q = L.latLng(nodes[i][1], nodes[i][0]);
                    var d = mapInst.distance(p, q);
                    if (d <= snapMeters && (!best || d < best.d)) {
                        best = { d: d, c: nodes[i] };
                    }
                }
                return best ? best.c : c;
            }

            function snapToWalkwaySegments(c) {
                const clickLL = L.latLng(c[1], c[0]);
                const clickPt = mapInst.project(clickLL);
                let best = null;

                (walkways || []).forEach(function (f) {
                    if (!f.geometry || f.geometry.type !== "LineString") return;
                    const segCoords = f.geometry.coordinates || [];
                    if (segCoords.length < 2) return;

                    for (let i = 0; i < segCoords.length - 1; i++) {
                        const A = segCoords[i];
                        const B = segCoords[i + 1];
                        const aLL = L.latLng(A[1], A[0]);
                        const bLL = L.latLng(B[1], B[0]);
                        const aPt = mapInst.project(aLL);
                        const bPt = mapInst.project(bLL);

                        const vx = bPt.x - aPt.x;
                        const vy = bPt.y - aPt.y;
                        const wx = clickPt.x - aPt.x;
                        const wy = clickPt.y - aPt.y;

                        const vv = vx * vx + vy * vy || 1e-12;
                        let t = (vx * wx + vy * wy) / vv;
                        if (t < 0) t = 0;
                        if (t > 1) t = 1;

                        const projX = aPt.x + t * vx;
                        const projY = aPt.y + t * vy;
                        const projLL = mapInst.unproject(L.point(projX, projY));

                        const dist = mapInst.distance(clickLL, projLL);
                        if (dist <= snapMeters && (!best || dist < best.dist)) {
                            best = {
                                dist: dist,
                                coord: [projLL.lng, projLL.lat]
                            };
                        }
                    }
                });

                return best ? best.coord : c;
            }

            // 1) snap every vertex
            const snapped = coords.map(function (c) {
                let s = snapToWalkwaySegments(c);
                if (s === c) s = snapToNodes(c);
                return s;
            });

            // 2) auto-close loops if start & end are almost the same
            if (snapped.length > 2) {
                const firstLL = L.latLng(snapped[0][1], snapped[0][0]);
                const lastLL = L.latLng(snapped[snapped.length - 1][1], snapped[snapped.length - 1][0]);
                if (mapInst.distance(firstLL, lastLL) <= snapMeters) {
                    snapped[snapped.length - 1] = snapped[0].slice();
                }
            }

            // 3) remove nearly duplicate vertices
            const cleaned = [];
            for (let i = 0; i < snapped.length; i++) {
                const c = snapped[i];
                if (!cleaned.length) {
                    cleaned.push(c);
                } else {
                    const prev = cleaned[cleaned.length - 1];
                    const d = mapInst.distance(
                        L.latLng(prev[1], prev[0]),
                        L.latLng(c[1], c[0])
                    );
                    if (d > 0.1) cleaned.push(c);
                }
            }

            return cleaned.length >= 2 ? cleaned : snapped;
        }


        /**
         * Splits a polyline coordinate array into consecutive 2-point segments.
         * @param {Array<[number,number]>} coords
         * @returns {Array<Array<[number,number]>>}
         */
        function splitIntoSegments(coords) {
            const segs = [];
            for (let i = 0; i < coords.length - 1; i++) segs.push([coords[i], coords[i + 1]]);
            return segs;
        }

        /**
         * Replaces a single segment [A,B] with a smooth local curve defined by [A,bend,B] and returns the full polyline.
         * @param {Array<[number,number]>} coords
         * @param {number} segIndex
         * @param {[number,number]} bend
         * @param {number} samples
         * @param {number} alpha
         * @returns {Array<[number,number]>}
         */
        function replaceSegmentWithLocalCurve(coords, segIndex, bend, samples, alpha) {
            const out = [];
            for (let i = 0; i < coords.length - 1; i++) {
                const A = coords[i], B = coords[i + 1];
                if (i === segIndex) {
                    const local = [A, bend, B];
                    const smooth = catmullRom(local, samples, alpha);
                    if (out.length === 0) out.push(smooth[0]);
                    for (let k = 1; k < smooth.length; k++) out.push(smooth[k]);
                } else {
                    if (out.length === 0) out.push(A);
                    out.push(B);
                }
            }
            return out;
        }

        /**
         * Updates the control array to reflect a bend inserted into one segment.
         * @param {Array<[number,number]>} coords
         * @param {number} segIndex
         * @param {[number,number]} bend
         * @returns {Array<[number,number]>}
         */
        function updateControlForSegment(coords, segIndex, bend) {
            const out = [];
            for (let i = 0; i < coords.length - 1; i++) {
                const A = coords[i], B = coords[i + 1];
                if (i === segIndex) {
                    if (out.length === 0) out.push(A);
                    out.push(bend);
                    out.push(B);
                } else {
                    if (out.length === 0) out.push(A);
                    out.push(B);
                }
            }
            return out;
        }

        /**
         * Catmull–Rom spline through control points returning a densified polyline.
         * @param {Array<[number,number]>} pts
         * @param {number} samples
         * @param {number} alpha
         * @returns {Array<[number,number]>}
         */
        function catmullRom(pts, samples, alpha) {
            if (!Array.isArray(pts) || pts.length < 2) return pts || [];
            const result = [];
            const a = Math.max(0, Math.min(1, alpha || 0.5));
            const s = Math.max(2, samples || 8);

            function tj(ti, pi, pj) {
                if (!pi || !pj) return ti;
                const dx = (pj[0] - pi[0]) || 0, dy = (pj[1] - pi[1]) || 0;
                const d = Math.sqrt(dx * dx + dy * dy);
                return Math.pow(d, a) + ti;
            }

            const p = [];
            p.push(pts[0]);
            for (let i = 0; i < pts.length; i++) p.push(pts[i]);
            p.push(pts[pts.length - 1]);

            for (let i = 0; i < p.length - 3; i++) {
                const p0 = p[i], p1 = p[i + 1], p2 = p[i + 2], p3 = p[i + 3];
                let t0 = 0;
                let t1 = tj(t0, p0, p1);
                let t2 = tj(t1, p1, p2);
                let t3 = tj(t2, p2, p3);

                for (let t = t1; t < t2; t += (t2 - t1) / s) {
                    const A1 = lerpPoint(p0, p1, (t1 - t) / (t1 - t0));
                    const A2 = lerpPoint(p1, p2, (t2 - t) / (t2 - t1));
                    const A3 = lerpPoint(p2, p3, (t3 - t) / (t3 - t2));
                    const B1 = lerpPoint(A1, A2, (t2 - t) / (t2 - t0));
                    const B2 = lerpPoint(A2, A3, (t3 - t) / (t3 - t1));
                    const C = lerpPoint(B1, B2, (t2 - t) / (t2 - t1));
                    if (Number.isFinite(C[0]) && Number.isFinite(C[1])) result.push(C);
                }
            }
            result.push(pts[pts.length - 1]);
            return result;
        }

        /**
         * Linear interpolation between two points with weight.
         * @param {[number,number]} a
         * @param {[number,number]} b
         * @param {number} w
         * @returns {[number,number]}
         */
        function lerpPoint(a, b, w) {
            const ww = Math.max(0, Math.min(1, 1 - (w || 0)));
            const ax = a ? a[0] : 0, ay = a ? a[1] : 0, bx = b ? b[0] : 0, by = b ? b[1] : 0;
            return [ax + (bx - ax) * ww, ay + (by - ay) * ww];
        }

        /**
         * Find the closest point on any existing walkway line to a given coordinate.
         * If within thresholdMeters, returns info for snapping and splitting.
         * @param {L.Map} mapInst
         * @param {[number,number]} coord [lng,lat] of the point to snap
         * @param {GeoJSON.Feature[]} walkways
         * @param {number} thresholdMeters
         * @returns {{
         *   feature: GeoJSON.Feature,
         *   snappedCoord: [number,number],
         *   segmentIndex: number,
         *   t: number,
         *   dist: number
         * }|null}
         */
        function findClosestSnapOnWalkways(mapInst, coord, walkways, thresholdMeters) {
            const clickLL = L.latLng(coord[1], coord[0]);
            const clickPt = mapInst.project(clickLL);

            let best = null;

            walkways.forEach(function (f) {
                if (!f.geometry || f.geometry.type !== "LineString") return;
                const coords = f.geometry.coordinates || [];
                if (coords.length < 2) return;

                for (let i = 0; i < coords.length - 1; i++) {
                    const A = coords[i];
                    const B = coords[i + 1];

                    const aLL = L.latLng(A[1], A[0]);
                    const bLL = L.latLng(B[1], B[0]);
                    const aPt = mapInst.project(aLL);
                    const bPt = mapInst.project(bLL);

                    const vx = bPt.x - aPt.x;
                    const vy = bPt.y - aPt.y;
                    const wx = clickPt.x - aPt.x;
                    const wy = clickPt.y - aPt.y;

                    const vv = vx * vx + vy * vy || 1e-12;
                    let t = (vx * wx + vy * wy) / vv;
                    if (t < 0) t = 0;
                    if (t > 1) t = 1;

                    const projX = aPt.x + t * vx;
                    const projY = aPt.y + t * vy;
                    const projLL = mapInst.unproject(L.point(projX, projY));

                    const dist = mapInst.distance(clickLL, projLL);
                    if (dist <= thresholdMeters && (!best || dist < best.dist)) {
                        best = {
                            feature: f,
                            snappedCoord: [projLL.lng, projLL.lat],
                            segmentIndex: i,
                            t: t,
                            dist: dist
                        };
                    }
                }
            });

            return best;
        }

        /**
         * Split a walkway feature at the given snapped point.
         * Replaces the original feature with two new features, updates the layer + array.
         * @param {L.Map} mapInst
         * @param {L.GeoJSON} walkwayLayer
         * @param {GeoJSON.Feature[]} walkwayFeatures
         * @param {{
         *   feature: GeoJSON.Feature,
         *   snappedCoord: [number,number],
         *   segmentIndex: number
         * }} snapInfo
         * @param {(layer:L.Layer)=>void} onAttach
         * @returns {Promise<void>}
         */
        async function splitWalkwayAtPoint(mapInst, walkwayLayer, walkwayFeatures, snapInfo, onAttach) {
            const orig = snapInfo.feature;
            if (!orig.geometry || orig.geometry.type !== "LineString") return;

            const coords = orig.geometry.coordinates.slice();
            const j = snapInfo.segmentIndex;
            const A = coords[j];
            const B = coords[j + 1];
            const P = snapInfo.snappedCoord;

            // If we're essentially at an endpoint, no real split needed.
            const same = function (c1, c2) {
                return Math.abs(c1[0] - c2[0]) < 1e-10 && Math.abs(c1[1] - c2[1]) < 1e-10;
            };
            const atA = same(P, A);
            const atB = same(P, B);

            if (atA || atB) {
                // No split, just keep endpoints as-is.
                return;
            }

            const before = coords.slice(0, j + 1);
            const after = coords.slice(j + 1);

            const firstCoords = before.concat([P]);
            const secondCoords = [P].concat(after);

            const baseProps = Object.assign({}, orig.properties || {});
            delete baseProps._id;  // let server assign new ids
            delete baseProps.segmentIndex;

            const f1 = {
                type: "Feature",
                geometry: { type: "LineString", coordinates: firstCoords },
                properties: Object.assign({}, baseProps)
            };

            const f2 = {
                type: "Feature",
                geometry: { type: "LineString", coordinates: secondCoords },
                properties: Object.assign({}, baseProps)
            };

            const origId = orig.properties && orig.properties._id;

            // Remove the original feature from memory
            const idx = walkwayFeatures.findIndex(f => f.properties && f.properties._id === origId);
            if (idx >= 0) walkwayFeatures.splice(idx, 1);

            // Remove the original layer from map
            let layerToRemove = null;
            walkwayLayer.eachLayer(function (l) {
                if (l.feature && l.feature.properties && l.feature.properties._id === origId) {
                    layerToRemove = l;
                }
            });
            if (layerToRemove) walkwayLayer.removeLayer(layerToRemove);

            // Persist new segments
            const saved1 = await CR.saveWalkway(f1);
            const saved2 = await CR.saveWalkway(f2);

            walkwayFeatures.push(saved1, saved2);

            // Add them back to the map
            function addWalkwayFeature(saved) {
                const g = L.geoJSON(saved, {
                    style: function () { return { color: "rgb(16,124,111)", weight: 3 }; }
                }).addTo(walkwayLayer);
                g.eachLayer(function (ll) { onAttach(ll); });
            }

            addWalkwayFeature(saved1);
            addWalkwayFeature(saved2);
        }

    }

    /**
     * Collect unique node candidates (endpoints) from all walkway features for snapping.
     * @param {GeoJSON.Feature[]} walkwayFeatures
     * @returns {Array<[number,number]>}
     */
    function collectWalkwayNodes(walkwayFeatures) {
        const nodes = [];
        const seen = new Set();
        (walkwayFeatures || []).forEach(function (f) {
            if (!f.geometry || f.geometry.type !== "LineString") return;
            const coords = f.geometry.coordinates || [];
            coords.forEach(function (c) {
                const key = c[0] + "," + c[1];
                if (seen.has(key)) return;
                seen.add(key);
                nodes.push([c[0], c[1]]);
            });
        });
        return nodes;
    }

    /**
     * Remove nearly duplicate consecutive vertices.
     * @param {L.Map} mapInst
     * @param {Array<[number,number]>} coords
     * @returns {Array<[number,number]>}
     */
    function dedupePolyline(mapInst, coords) {
        const cleaned = [];
        for (let i = 0; i < coords.length; i++) {
            const c = coords[i];
            if (!cleaned.length) {
                cleaned.push(c);
            } else {
                const prev = cleaned[cleaned.length - 1];
                const d = mapInst.distance(
                    L.latLng(prev[1], prev[0]),
                    L.latLng(c[1], c[0])
                );
                if (d > 0.05) cleaned.push(c);
            }
        }
        return cleaned.length >= 2 ? cleaned : coords;
    }

    /**
     * Snap edited polyline vertices to nearest known nodes within tolerance.
     * @param {L.Map} mapInst
     * @param {Array<[number,number]>} coords
     * @param {Array<[number,number]>} nodes
     * @param {number} tolMeters
     * @returns {Array<[number,number]>}
     */
    function snapEditedPolyline(mapInst, coords, nodes, tolMeters) {
        const snapped = coords.map(function (c) {
            let best = null;
            const ll = L.latLng(c[1], c[0]);
            nodes.forEach(function (n) {
                const d = mapInst.distance(ll, L.latLng(n[1], n[0]));
                if (d <= tolMeters && (!best || d < best.d)) best = { d: d, c: n };
            });
            return best ? best.c : c;
        });
        return dedupePolyline(mapInst, snapped);
    }

    /**
     * Persist an edited walkway layer back to the server, snapping endpoints to nearby nodes.
     * @param {L.Map} mapInst
     * @param {L.Layer} layer
     * @param {GeoJSON.Feature[]} walkwayFeatures
     * @returns {Promise<void>}
     */
    async function persistEditedWalkway(mapInst, layer, walkwayFeatures) {
        const props = layer.feature && layer.feature.properties ? layer.feature.properties : {};
        const latlngs = layer.getLatLngs();
        if (!latlngs || !latlngs.length) return;
        const coords = latlngs.map(function (ll) { return [ll.lng, ll.lat]; });

        // START FIX: Exclude the current walkway from the snap pool so it doesn't snap to its old self
        const otherWalkways = walkwayFeatures.filter(f => f.properties._id !== props._id);
        const nodes = collectWalkwayNodes(otherWalkways);
        // END FIX

        const snappedCoords = snapEditedPolyline(mapInst, coords, nodes, EDIT_SNAP_METERS);
        
        const updated = {
            type: "Feature",
            geometry: { type: "LineString", coordinates: snappedCoords },
            properties: Object.assign({}, props)
        };
        
        const saved = await CR.saveWalkway(updated);
        
        // Update local layer state
        layer.feature = saved;
        layer.setLatLngs(snappedCoords.map(function (c) { return [c[1], c[0]]; }));
        
        // Update master array
        const idx = walkwayFeatures.findIndex(function (f) { return f.properties && props._id && f.properties._id === props._id; });
        if (idx >= 0) {
            walkwayFeatures[idx] = saved;
        } else {
            walkwayFeatures.push(saved);
        }
    }

    /**
     * Sanitizes a FeatureCollection of walkways to remove degenerate or out-of-bounds coordinates.
     * @param {GeoJSON.FeatureCollection} fc
     * @returns {GeoJSON.FeatureCollection}
     */
    function sanitizeFeatureCollection(fc) {
        const out = { type: "FeatureCollection", features: [] };
        const feats = (fc && fc.features) || [];
        for (let i = 0; i < feats.length; i++) {
            const clean = sanitizeWalkwayFeature(feats[i]);
            if (clean) out.features.push(clean);
        }
        return out;
    }

    /**
     * Sanitizes a single walkway feature by dropping invalid points and clamping lat/lng to world extents.
     * @param {GeoJSON.Feature} f
     * @returns {GeoJSON.Feature|null}
     */
    function sanitizeWalkwayFeature(f) {
        if (!f || !f.geometry || f.geometry.type !== "LineString") return null;
        const coords = Array.isArray(f.geometry.coordinates) ? f.geometry.coordinates : [];
        const cleaned = [];
        for (let i = 0; i < coords.length; i++) {
            const c = coords[i] || [];
            let lng = Number(c[0]), lat = Number(c[1]);
            if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
            if (Math.abs(lng) > 180 || Math.abs(lat) > 90) continue;
            cleaned.push([lng, lat]);
        }
        if (cleaned.length < 2) return null;
        return {
            type: "Feature",
            geometry: { type: "LineString", coordinates: cleaned },
            properties: Object.assign({}, f.properties || {}, { control: (f.properties && f.properties.control) || cleaned.slice() })
        };
    }

    /**
     * Generates an automatic entrance name and association.
     * @param {GeoJSON.Feature} entrancePoint
     * @param {GeoJSON.Feature[]} allFeatures
     * @returns {{ suggestedName: string, buildingId?: string, direction?: string }}
     */
    function autoNameEntrance(entrancePoint, allFeatures) {
        var buildings = allFeatures.filter(function (f) { return f.properties && f.properties.type === "building" && f.geometry && f.geometry.type === "Polygon"; });

        var best = findBuildingForPoint(entrancePoint, buildings);
        var building = best && best.building;
        var buildingId = building && building.properties && building.properties._id;
        var prefix = building && building.properties && building.properties.prefix
            ? String(building.properties.prefix).toUpperCase()
            : (building && building.properties && building.properties.name ? acronym(building.properties.name) : "BLD");

        var dir = building ? directionFrom(building, entrancePoint) : "N";
        var index = nextEntranceIndex(prefix, dir, buildingId, allFeatures);
        var suggested = prefix + "-" + dir + String(index);

        return { suggestedName: suggested, buildingId: buildingId, direction: dir };
    }

    /**
     * Finds building containing or nearest to point.
     * @param {GeoJSON.Feature} pt
     * @param {GeoJSON.Feature[]} buildings
     * @returns {{ building: GeoJSON.Feature, distance: number }|null}
     */
    function findBuildingForPoint(pt, buildings) {
        var inside = null;
        for (var i = 0; i < buildings.length; i++) {
            try { if (turf.booleanPointInPolygon(pt, buildings[i])) { inside = { building: buildings[i], distance: 0 }; break; } }
            catch (_) {}
        }
        if (inside) return inside;

        var best = null;
        for (var j = 0; j < buildings.length; j++) {
            try {
                var dist = turf.pointToLineDistance(pt, turf.polygonToLine(buildings[j]), { units: "meters" });
                if (!best || dist < best.distance) best = { building: buildings[j], distance: dist };
            } catch (_) {
                try {
                    var c = turf.centerOfMass(buildings[j]);
                    var d2 = turf.distance(pt, c, { units: "meters" });
                    if (!best || d2 < best.distance) best = { building: buildings[j], distance: d2 };
                } catch(__) {}
            }
        }
        return best;
    }

    /**
     * Computes 8-way direction from building centroid to a point.
     * @param {GeoJSON.Feature} buildingPolygon
     * @param {GeoJSON.Feature} point
     * @returns {"N"|"NE"|"E"|"SE"|"S"|"SW"|"W"|"NW"}
     */
    function directionFrom(buildingPolygon, point) {
        try {
            var c = turf.centerOfMass(buildingPolygon);
            var brg = turf.bearing(c, point);
            var b = ((brg % 360) + 360) % 360;
            if (b >= 337.5 || b < 22.5) return "N";
            if (b < 67.5) return "NE";
            if (b < 112.5) return "E";
            if (b < 157.5) return "SE";
            if (b < 202.5) return "S";
            if (b < 247.5) return "SW";
            if (b < 292.5) return "W";
            return "NW";
        } catch (_) { return "N"; }
    }

    /**
     * Creates an acronym from building name.
     * @param {string} name
     * @returns {string}
     */
    function acronym(name) {
        var words = String(name).trim().split(/\s+/).filter(Boolean);
        if (words.length === 1) {
            var w = words[0].toUpperCase();
            return (w[0] || "B") + (w[1] || "L");
        }
        var letters = words.map(function (w) { return w[0]; }).join("").toUpperCase();
        return letters.slice(0, 3);
    }

    /**
     * Gets next available index for prefix+direction within a building.
     * @param {string} prefix
     * @param {string} direction
     * @param {string|undefined} buildingId
     * @param {GeoJSON.Feature[]} features
     * @returns {number}
     */
    function nextEntranceIndex(prefix, direction, buildingId, features) {
        var entrances = features.filter(function (f) {
            if (!f.properties || f.properties.type !== "entrance") return false;
            if (buildingId && f.properties.buildingId !== buildingId) return false;
            var name = f.properties.name || "";
            var dir = f.properties.direction || inferDirectionFromName(name);
            var pre = inferPrefixFromName(name);
            return dir === direction && pre === prefix;
        });
        var used = {};
        entrances.forEach(function (f) {
            var n = extractIndex(f.properties.name || "");
            if (n) used[n] = true;
        });
        var idx = 1;
        while (used[idx]) idx += 1;
        return idx;
    }

    /**
     * Extracts prefix from names like "HU-N3".
     * @param {string} name
     * @returns {string|undefined}
     */
    function inferPrefixFromName(name) {
        var m = String(name).match(/^([A-Z0-9]+)-/i);
        return m ? m[1].toUpperCase() : undefined;
    }

    /**
     * Extracts direction from names like "HU-N3".
     * @param {string} name
     * @returns {string|undefined}
     */
    function inferDirectionFromName(name) {
        var m = String(name).match(/-([NSEW]{1,2})\d*$/i);
        return m ? m[1].toUpperCase() : undefined;
    }

    /**
     * Extracts trailing numeric index.
     * @param {string} name
     * @returns {number|undefined}
     */
    function extractIndex(name) {
        var m = String(name).match(/(\d+)$/);
        return m ? parseInt(m[1], 10) : undefined;
    }
    /**
    * Audits the walkway network and highlights disconnected "islands" in red.
    */
    function auditNetworkConnectivity(map, walkwayFeatures, walkwayLayer) {
        if (walkwayFeatures.length === 0) {
            alert("No walkways to audit!");
            return;
        }

        console.log("--- Starting Network Audit ---");
            
        // 1. Build adjacency list (Standard connection check)
        const adjacency = new Map();
        walkwayFeatures.forEach((f1, i) => {
            adjacency.set(i, []);
            walkwayFeatures.forEach((f2, j) => {
                if (i === j) return;
                let connected = false;
                try {
                    if (turf.booleanIntersects(f1, f2)) {
                        connected = true;
                    } else {
                        for (let c1 of f1.geometry.coordinates) {
                            const snapped = turf.nearestPointOnLine(f2, turf.point(c1), { units: "meters" });
                            if (snapped.properties && snapped.properties.dist <= SNAP_METERS) {
                                connected = true;
                                break;
                            }
                        }
                    }
                } catch (e) {}
                if (connected) adjacency.get(i).push(j);
            });
        });

        // 2. BFS to find the main network
        const visited = new Set();
        const components = [];
        for (let i = 0; i < walkwayFeatures.length; i++) {
            if (!visited.has(i)) {
                const component = [];
                const queue = [i];
                visited.add(i);
                while (queue.length > 0) {
                    const current = queue.shift();
                    component.push(current);
                    adjacency.get(current).forEach(neighbor => {
                        if (!visited.has(neighbor)) {
                            visited.add(neighbor);
                            queue.push(neighbor);
                        }
                    });
                }
                components.push(component);
            }
        }
        components.sort((a, b) => b.length - a.length);
        const mainNetworkIndices = new Set(components[0]);

        // 3. Prepare the Map layers
        if (map._gapLayer) map.removeLayer(map._gapLayer);
        map._gapLayer = L.layerGroup().addTo(map);

        // 4. Process Islands and find Gaps
        let islandCount = 0;
        walkwayLayer.eachLayer(layer => {
            const feat = layer.feature;
            const featureIndex = walkwayFeatures.findIndex(f => f.properties._id === feat.properties._id);
                
            if (!mainNetworkIndices.has(featureIndex)) {
                islandCount++;
                layer.setStyle({ color: "#ff0000", weight: 6, dashArray: "10, 10" });

                // Find the closest point between THIS island and the ENTIRE main network
                let minBridgingDist = Infinity;
                let bestGapPoint = null;

                mainNetworkIndices.forEach(mainIdx => {
                    const mainFeat = walkwayFeatures[mainIdx];
                    // Check every vertex of the island line
                    feat.geometry.coordinates.forEach(coord => {
                        const islandPt = turf.point(coord);
                        const closestOnMain = turf.nearestPointOnLine(mainFeat, islandPt, { units: 'meters' });
                        const dist = closestOnMain.properties.dist;

                        if (dist < minBridgingDist) {
                            minBridgingDist = dist;
                            bestGapPoint = closestOnMain;
                        }
                    });
                });

                // Drop a marker if a valid gap was found
                if (bestGapPoint && minBridgingDist > SNAP_METERS) {
                    console.log(`Gap Found: ${minBridgingDist.toFixed(2)}m for feature ${feat.properties._id}`);
                    L.circleMarker([bestGapPoint.geometry.coordinates[1], bestGapPoint.geometry.coordinates[0]], {
                        radius: 12,
                        color: 'yellow',
                        weight: 4,
                        fillColor: 'red',
                        fillOpacity: 1,
                        pane: 'markerPane' // Ensure it's on top of lines
                    }).addTo(map._gapLayer)
                      .bindPopup(`<b>Gap Detected:</b> ${minBridgingDist.toFixed(2)}m from main network.`);
                }
            } else {
                layer.setStyle({ color: "rgb(16,124,111)", weight: 3, dashArray: null });
            }
        });

        alert(`Audit Complete: Found ${islandCount} islands. Check the RED lines and YELLOW markers.`);
    }

    window.CR = window.CR || {};
    window.CR.bootAdmin = bootAdmin;
})();

document.addEventListener("DOMContentLoaded", function () {
    CR.bootAdmin();
    CR.initBugLog();
});
