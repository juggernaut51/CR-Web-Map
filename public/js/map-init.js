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
