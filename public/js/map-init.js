(async function () {
    const map = CR.initMap("map");
    const [features, walkways] = await Promise.all([
        CR.fetchFeatures(),
        CR.fetchWalkways()
    ]);

    const pointsOnly = {
        type: "FeatureCollection",
        features: features.features.filter(f => f.geometry && f.geometry.type === "Point")
    };
    const featuresLayer = CR.createFeaturesLayer(pointsOnly).addTo(map);
    window.featuresFc = features;

    const buildingLabels = L.layerGroup();
    features.features.forEach(f => {
        if (!f.properties || f.properties.type !== "building") return;
        if (!f.properties.name) return;
        if (!f.geometry || f.geometry.type !== "Polygon") return;
        const center = turf.centerOfMass(f);
        const [lng, lat] = center.geometry.coordinates;
        L.marker([lat, lng], {
            icon: L.divIcon({
                className: "building-label",
                html: `<span>${f.properties.name}</span>`,
                iconSize: [0, 0]
            }),
            interactive: false,
            keyboard: false
        }).addTo(buildingLabels);
    });
    map._buildingLabels = buildingLabels;

    if (CR.initRouting) {
        CR.initRouting(map, walkways, null);
    }

    if (CR.initUtilityDrawer) {
        CR.initUtilityDrawer(map);
        CR.initBugReport(map);
    }

    const sidebar = document.getElementById("route-sidebar");
    const sidebarHeader = sidebar ? sidebar.querySelector("header") : null;

    // --- Bottom-sheet drag (mobile) + click-toggle (desktop) ---
    const SNAP = { FULL: 0, PEEK: 55, HIDDEN: 100 };
    let _sheetPct = SNAP.HIDDEN;

    // Use setProperty with 'important' so inline style beats CSS !important rules
    function sheetSetTransform(pct, animate) {
        if (!sidebar) return;
        const ease = 'transform 0.32s cubic-bezier(0.32,0.72,0,1)';
        sidebar.style.setProperty('transition', animate ? ease : 'none', 'important');
        sidebar.style.setProperty('transform', `translateY(${pct}%)`, 'important');
    }

    function sheetSnapTo(pct) {
        if (!sidebar) return;
        _sheetPct = pct;
        sheetSetTransform(pct, true);
        sidebar.classList.toggle('expanded', pct === SNAP.FULL);
    }

    if (sidebarHeader && sidebar) {
        let dragging = false;
        let startY = 0;
        let startPct = SNAP.HIDDEN;
        let moved = false;
        let suppressClick = false;

        sidebarHeader.addEventListener('touchstart', function (e) {
            dragging = true;
            moved = false;
            suppressClick = false;
            startY = e.touches[0].clientY;
            startPct = _sheetPct;
            sheetSetTransform(_sheetPct, false); // disable transition for drag
        }, { passive: true });

        window.addEventListener('touchmove', function (e) {
            if (!dragging) return;
            const y = e.touches[0].clientY;
            const h = sidebar.offsetHeight || 1;
            const newPct = Math.max(0, Math.min(100, startPct + ((y - startY) / h) * 100));
            if (Math.abs(y - startY) > 8) moved = true;
            _sheetPct = newPct;
            sidebar.style.setProperty('transform', `translateY(${newPct}%)`, 'important');
            sidebar.classList.toggle('expanded', newPct < 5);
        }, { passive: true });

        window.addEventListener('touchend', function () {
            if (!dragging) return;
            dragging = false;
            suppressClick = true;
            if (!moved) {
                sheetSnapTo(_sheetPct > 20 ? SNAP.FULL : SNAP.HIDDEN);
                return;
            }
            if (_sheetPct >= 90) {
                sheetSnapTo(SNAP.HIDDEN);
            } else {
                // Stay where released — restore transition for future snaps
                sheetSetTransform(_sheetPct, true);
            }
        });

        // Desktop: click header to toggle
        sidebarHeader.addEventListener('click', function (e) {
            e.stopPropagation();
            if (suppressClick) { suppressClick = false; return; }
            if (window.innerWidth > 768) sidebar.classList.toggle('expanded');
        });
    }

    const utilityDrawer = document.getElementById("utility-drawer");
    const utilityHeader = utilityDrawer ? utilityDrawer.querySelector("header") : null;
    const utilityCloseBtn = document.getElementById("utility-close");

    if (utilityHeader && utilityCloseBtn) {
        utilityHeader.addEventListener("click", (e) => {
            e.stopPropagation();
            if (e.target !== utilityCloseBtn) {
                utilityCloseBtn.click();
            }
        });
    }

    setTimeout(() => { map.invalidateSize(); }, 300);

    // Mobile search bar
    const mobileGoBtn = document.getElementById('mobile-go-btn');
    const mobileFromInput = document.getElementById('mobile-from-input');
    const mobileToInput = document.getElementById('mobile-to-input');
    const routeSidebar = document.getElementById('route-sidebar');

    if (mobileGoBtn) {
        const triggerMobileSearch = () => {
            const startInput = document.getElementById('route-start-search');
            const endInput = document.getElementById('route-end-search');
            const searchBtn = document.getElementById('route-end-btn');
            if (startInput) startInput.value = mobileFromInput.value;
            if (endInput) endInput.value = mobileToInput.value;
            if (searchBtn) searchBtn.click();
            if (typeof sheetSnapTo === 'function') sheetSnapTo(SNAP.FULL);
            else if (routeSidebar) routeSidebar.classList.add('expanded');
            mobileFromInput.blur();
            mobileToInput.blur();
        };

        mobileGoBtn.addEventListener('click', triggerMobileSearch);
        [mobileFromInput, mobileToInput].forEach(el => {
            if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') triggerMobileSearch(); });
        });

        const clearBtn = document.getElementById('route-clear');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                if (typeof sheetSnapTo === 'function') sheetSnapTo(SNAP.HIDDEN);
                else if (routeSidebar) routeSidebar.classList.remove('expanded');
                if (mobileFromInput) mobileFromInput.value = '';
                if (mobileToInput) mobileToInput.value = '';
            });
        }
    }

    // Welcome modal — show once per browser, reusable via CR.openWelcome
    const welcomeScrim = document.getElementById('welcome-modal-scrim');
    const welcomeBtn = document.getElementById('welcome-got-it');

    function openWelcome() {
        if (!welcomeScrim) return;
        welcomeScrim.classList.add('open');
        welcomeScrim.setAttribute('aria-hidden', 'false');
    }

    function closeWelcome() {
        if (!welcomeScrim) return;
        welcomeScrim.classList.remove('open');
        welcomeScrim.setAttribute('aria-hidden', 'true');
        localStorage.setItem('cr_map_welcomed', '1');
    }

    if (welcomeBtn) welcomeBtn.addEventListener('click', closeWelcome);
    if (welcomeScrim) {
        welcomeScrim.addEventListener('click', (e) => {
            if (e.target === welcomeScrim) closeWelcome();
        });
    }

    if (!localStorage.getItem('cr_map_welcomed')) openWelcome();

    CR.openWelcome = openWelcome;
    CR.sheetSnapTo = sheetSnapTo;

    // Mobile basemap float — syncs with the drawer toggle
    const mobileBasemapFloat = document.getElementById('mobile-basemap-float');
    if (mobileBasemapFloat) {
        mobileBasemapFloat.addEventListener('click', e => {
            const btn = e.target.closest('[data-base-layer]');
            if (!btn) return;
            const layerName = btn.getAttribute('data-base-layer');
            CR.setBaseLayer(map, layerName);
            mobileBasemapFloat.querySelectorAll('.mbasemap-btn').forEach(b => {
                b.classList.toggle('active', b === btn);
            });
        });
    }
})();
