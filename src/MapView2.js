import React, { useRef, useEffect, useState, useMemo } from "react";
import mapboxgl from "mapbox-gl";
import redliningData from "./data/redlined_with_all_metrics.json";

mapboxgl.accessToken =
  "pk.eyJ1IjoiemhlbmdmYW4wMDAwIiwiYSI6ImNtOTY1YWkxMTB0b3QyaW9xeDB2dzdtcjAifQ.Efsxuzjn9FGnLZOoMVUUIA";

/* ───── CONFIG ───── */
const HEIGHT_MULTIPLIER = 1200; // max extrusion height, in meters-ish
const BOX_SIZE = 0.002;        // ~200 m at Boston’s latitude

export default function MapView() {
  const mapContainer = useRef(null);
  const map = useRef(null);

  /* ───── STEP DEFINITIONS (ALL FEATURES) ───── */
  const storySteps = [
    { title: "Redlining Overview", description: "Historic redlining zones.", dataField: null },
    { title: "Median Income", dataField: "Average_Income" },
    { title: "Evictions (all yrs)", dataField: "eviction_count_all_years" },
    { title: "Crime (all yrs)", dataField: "crime_count_all_years" },
    { title: "Poor Health %", dataField: "poor_health_pct" },
    { title: "Smoking %", dataField: "smoking_pct" },
    { title: "Mental Distress %", dataField: "mental_distress_pct" },
    { title: "Homeownership %", dataField: "homeownership_pct" },
    { title: "Rentership %", dataField: "rentership_pct" },
    { title: "Unemployment %", dataField: "unemployment_pct" },
    { title: "Crowded Housing %", dataField: "crowded_housing_pct" }
  ];

  const [currentStep, setCurrentStep] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  /* ───── Helpers ───── */
  const getCentroid = (wkt) => {
    const nums = wkt.replace(/[^0-9\.,\-\s]/g, "").trim();
    const pairs = nums.split(/,\s*/).map((p) => p.split(/\s+/).map(Number));
    const lngs = pairs.map((p) => p[0]);
    const lats = pairs.map((p) => p[1]);
    return [
      (Math.min(...lngs) + Math.max(...lngs)) / 2,
      (Math.min(...lats) + Math.max(...lats)) / 2
    ];
  };

  const processedData = useMemo(
    () =>
      redliningData
        .filter((f) => f.city?.toLowerCase() === "boston")
        .map((f) => ({ ...f, position: getCentroid(f.geometry) })),
    []
  );

  /* ───── Pre‑compute min/max for every numeric field ───── */
  const fieldStats = useMemo(() => {
    const stats = {};
    processedData.forEach((row) => {
      Object.entries(row).forEach(([k, v]) => {
        if (typeof v === "number" && Number.isFinite(v)) {
          if (!stats[k]) stats[k] = { min: v, max: v };
          else {
            stats[k].min = Math.min(stats[k].min, v);
            stats[k].max = Math.max(stats[k].max, v);
          }
        }
      });
    });
    return stats;
  }, [processedData]);

  /* ───── Build GeoJSON for given step (normalized) ───── */
  const buildGeoJSON = (stepIdx) => {
    const field = storySteps[stepIdx].dataField;
    const { min, max } = field ? fieldStats[field] || {} : {};
    const range = max - min || 1; // avoid zero division

    const features = processedData.map((row) => {
      const [lng, lat] = row.position;
      const rawVal = field ? Number(row[field]) : null;
      const norm = field ? (rawVal - min) / range : 0; // 0‑1
      const height = norm * HEIGHT_MULTIPLIER;
      return {
        type: "Feature",
        properties: {
          zone: row.zone_idx,
          value: rawVal,
          norm,
          height
        },
        geometry: {
          type: "Polygon",
          coordinates: [[
            [lng - BOX_SIZE, lat - BOX_SIZE],
            [lng + BOX_SIZE, lat - BOX_SIZE],
            [lng + BOX_SIZE, lat + BOX_SIZE],
            [lng - BOX_SIZE, lat + BOX_SIZE],
            [lng - BOX_SIZE, lat - BOX_SIZE]
          ]]
        }
      };
    });
    return { type: "FeatureCollection", features };
  };

  /* ───── Initialize map once ───── */
  useEffect(() => {
    if (map.current || !mapContainer.current) return;

    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: "mapbox://styles/mapbox/light-v11",
      center: [-71.0589, 42.3601],
      zoom: 11,
      pitch: 45,
      bearing: 0,
      antialias: true
    });

    map.current.on("load", () => {
      map.current.addSource("boxes", {
        type: "geojson",
        data: buildGeoJSON(currentStep)
      });

      map.current.addLayer({
        id: "boxes-layer",
        type: "fill-extrusion",
        source: "boxes",
        paint: {
          "fill-extrusion-height": ["get", "height"],
          "fill-extrusion-base": 0,
          "fill-extrusion-opacity": 0.85,
          "fill-extrusion-color": [
            "interpolate",
            ["linear"],
            ["get", "norm"],
            0, "#d9ef8b",
            0.5, "#66bd63",
            1, "#1a9850"
          ]
        }
      });

      const popup = new mapboxgl.Popup({ closeButton: false, closeOnClick: false });
      map.current.on("mousemove", "boxes-layer", (e) => {
        map.current.getCanvas().style.cursor = "pointer";
        const f = e.features[0];
        const val = f.properties.value;
        const display = val === null ? "N/A" : Number(val).toLocaleString();
        popup
          .setLngLat(e.lngLat)
          .setHTML(`<strong>Zone ${f.properties.zone}</strong><br/>${storySteps[currentStep].title}: ${display}`)
          .addTo(map.current);
      });
      map.current.on("mouseleave", "boxes-layer", () => {
        map.current.getCanvas().style.cursor = "";
        popup.remove();
      });
    });
  }, []);

  /* ───── Update source on step change ───── */
  useEffect(() => {
    if (!map.current) return;
    const src = map.current.getSource("boxes");
    if (src) src.setData(buildGeoJSON(currentStep));
  }, [currentStep, fieldStats]);

  /* ───── UI ───── */
  return (
    <div style={{ display: "flex", position: "relative" }}>
      {/* Sidebar */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: sidebarOpen ? 0 : -320,
          width: 300,
          height: "100vh",
          background: "rgba(255,255,255,0.25)",
          backdropFilter: "blur(14px)",
          padding: 16,
          boxSizing: "border-box",
          transition: "left 0.3s",
          zIndex: 2,
          overflowY: "auto"
        }}
      >
        <h3 style={{ margin: 0 }}>{storySteps[currentStep].title}</h3>
        {storySteps[currentStep].description && (
          <p style={{ marginTop: 6 }}>{storySteps[currentStep].description}</p>
        )}
        <div style={{ marginTop: 16, display: "flex", justifyContent: "space-between" }}>
          <button onClick={() => setCurrentStep((p) => Math.max(0, p - 1))}>Prev</button>
          <button onClick={() => setCurrentStep((p) => Math.min(storySteps.length - 1, p + 1))}>Next</button>
        </div>
        <p style={{ marginTop: 12, fontSize: 12, opacity: 0.7 }}>Data normalized (min‑max) per feature</p>
      </div>

      {/* Toggle */}
      <button
        onClick={() => setSidebarOpen(!sidebarOpen)}
        style={{
          position: "absolute",
          top: "50%",
          left: sidebarOpen ? 300 : 0,
          transform: "translateY(-50%)",
          zIndex: 3,
          background: "rgba(255,255,255,0.4)",
          border: "1px solid rgba(0,0,0,0.15)",
          borderRadius: sidebarOpen ? "0 6px 6px 0" : "6px 0 0 6px",
          padding: 6,
          cursor: "pointer"
        }}
        title={sidebarOpen ? "Hide panel" : "Show panel"}
      >
        {sidebarOpen ? "\u25C0" : "\u25B6"}
      </button>

      {/* Map */}
      <div ref={mapContainer} style={{ width: "100%", height: "100vh" }} />
    </div>
  );
}
