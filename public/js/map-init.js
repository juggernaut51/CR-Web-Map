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

    if (sidebarHeader) {
        sidebarHeader.addEventListener("click", (e) => {
            e.stopPropagation();
            sidebar.classList.toggle("expanded");
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
})();
