import React, { useRef, useEffect, useState, useMemo } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";                          // 别忘了样式
import redliningData from "./data/redlined_with_all_metrics.json";

/* ═══ 基本配置 ═══ */
mapboxgl.accessToken =
  "pk.eyJ1IjoiemhlbmdmYW4wMDAwIiwiYSI6ImNtOTY1YWkxMTB0b3QyaW9xeDB2dzdtcjAifQ.Efsxuzjn9FGnLZOoMVUUIA";

const HEIGHT_MULTIPLIER = 1200;  // 柱体高度缩放
const BOX_SIZE = 0.002;         // 每个方块半边长（° ≈ 200 m）
const HOLC_COLORS = { A: "#41b6c4", B: "#2c7fb8", C: "#fed976", D: "#e31a1c" };

/* ═══ WKT→MultiPolygon 解析 ═══ */
function wktToMultiPolygon(wkt) {
  if (!wkt?.startsWith("MULTIPOLYGON")) return [];
  const body = wkt
    .replace(/^MULTIPOLYGON\s*\(\(\(/i, "")
    .replace(/\)\)\)\s*$/i, "");
  return body.split(/\)\)\s*,\s*\(\(/).map(poly =>
    poly.split(/\)\s*,\s*\(/).map(ring =>
      ring
        .replace(/[()]/g, "")
        .trim()
        .split(/,\s*/)
        .map(pt => pt.split(/\s+/).map(Number))
    )
  );
}


/* ─────────────────────────────────────── */
export default function MapView() {
  const mapRef       = useRef(null);
  const containerRef = useRef(null);

  /* UI 状态 */
  const [step,    setStep]    = useState(0);
  const [sidebar, setSidebar] = useState(true);

  /* 步骤定义 */
  const steps = [
    { title: "Redlining Overview", description: "Historic redlining zones", field: null },
    { title: "Median Income",            field: "Average_Income" },
    { title: "Evictions (all yrs)",      field: "eviction_count_all_years" },
    { title: "Crime (all yrs)",          field: "crime_count_all_years" },
    { title: "Poor Health %",            field: "poor_health_pct" },
    { title: "Smoking %",                field: "smoking_pct" },
    { title: "Mental Distress %",        field: "mental_distress_pct" },
    { title: "Homeownership %",          field: "homeownership_pct" },
    { title: "Rentership %",             field: "rentership_pct" },
    { title: "Unemployment %",           field: "unemployment_pct" },
    { title: "Crowded Housing %",        field: "crowded_housing_pct" }
  ];

  /* 解析 & 计算 centroid */
  const zones = useMemo(() =>
    redliningData
      .filter(r => (r.city || "").toLowerCase() === "boston")
      .map(r => {
        const poly = wktToMultiPolygon(r.geometry);
        if (!poly.length) return null; // 跳过坏数据
        const flat = poly.flat(2);
        const lngs = flat.filter((_, i) => i % 2 === 0);
        const lats = flat.filter((_, i) => i % 2 === 1);
        const centroid = [
          (Math.min(...lngs) + Math.max(...lngs)) / 2,
          (Math.min(...lats) + Math.max(...lats)) / 2
        ];
        return { ...r, poly, centroid };
      })
      .filter(Boolean), []
  );

  /* min/max 用于归一化 */
  const stats = useMemo(() => {
    const s = {};
    zones.forEach(z => {
      Object.entries(z).forEach(([k, v]) => {
        if (typeof v === "number" && Number.isFinite(v)) {
          s[k] ??= { min: v, max: v };
          s[k].min = Math.min(s[k].min, v);
          s[k].max = Math.max(s[k].max, v);
        }
      });
    });
    return s;
  }, [zones]);

  /* 构造柱体 GeoJSON（过滤 NaN） */
  const buildBoxes = idx => {
    const field = steps[idx].field;
    if (!field) return { type: "FeatureCollection", features: [] };
    const { min, max } = stats[field] || { min: 0, max: 1 };
    const rng = max - min || 1;
    return {
      type: "FeatureCollection",
      features: zones
        .map(z => {
          const raw = Number(z[field]);
          if (!Number.isFinite(raw)) return null;       // <- 过滤缺失
          const norm = (raw - min) / rng;
          const h    = norm * HEIGHT_MULTIPLIER;
          const [lng, lat] = z.centroid;
          return {
            type: "Feature",
            properties: { zone: z.zone_idx, value: raw, norm, height: h },
            geometry: { type: "Polygon", coordinates: [[
              [lng-BOX_SIZE, lat-BOX_SIZE],
              [lng+BOX_SIZE, lat-BOX_SIZE],
              [lng+BOX_SIZE, lat+BOX_SIZE],
              [lng-BOX_SIZE, lat+BOX_SIZE],
              [lng-BOX_SIZE, lat-BOX_SIZE]
            ]]}
          };
        })
        .filter(Boolean)
    };
  };

  /* 多边形 GeoJSON */
  const zonesGeo = useMemo(() => ({
    type: "FeatureCollection",
    features: zones.map(z => ({
      type: "Feature",
      properties: { grade: z.holc_grade, zone: z.zone_idx },
      geometry: { type: "MultiPolygon", coordinates: z.poly }
    }))
  }), [zones]);

  /* 初始化地图 */
  useEffect(() => {
    if (mapRef.current || !containerRef.current) return;

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: "mapbox://styles/mapbox/light-v11",
      center: [-71.0589, 42.3601],
      zoom: 11,
      pitch: 45,
      antialias: true
    });
    mapRef.current = map;
    window._map = map;                                  // 调试用

    map.on("load", () => {
      /* 面填充 */
      map.addSource("zones", { type: "geojson", data: zonesGeo });
      map.addLayer({
        id: "zones-fill",
        type: "fill",
        source: "zones",
        paint: {
          "fill-color": [
            "match", ["get", "grade"],
            "A", HOLC_COLORS.A, "B", HOLC_COLORS.B,
            "C", HOLC_COLORS.C, "D", HOLC_COLORS.D,
            "#ccc"
          ],
          "fill-opacity": 0.55
        }
      });

      /* 柱体 */
      map.addSource("boxes", { type: "geojson", data: buildBoxes(step) });
      map.addLayer({
        id: "boxes-layer",
        type: "fill-extrusion",
        source: "boxes",
        paint: {
          "fill-extrusion-height": ["get", "height"],
          "fill-extrusion-base": 0,
          "fill-extrusion-opacity": 0.85,
          "fill-extrusion-color": [
            "interpolate", ["linear"], ["get", "norm"],
            0, "#d9ef8b", 0.5, "#66bd63", 1, "#1a9850"
          ]
        }
      });

      /* Popup（防空 features） */
      const popup = new mapboxgl.Popup({ closeButton: false, closeOnClick: false });
      map.on("mousemove", "boxes-layer", e => {
        if (!e.features?.length) {
          map.getCanvas().style.cursor = "";
          popup.remove();
          return;
        }
        map.getCanvas().style.cursor = "pointer";
        const f = e.features[0];
        popup
          .setLngLat(e.lngLat)
          .setHTML(
            `<strong>Zone ${f.properties.zone}</strong><br/>` +
            `${steps[step].title}: ${Number(f.properties.value).toLocaleString()}`
          )
          .addTo(map);
      });
      map.on("mouseleave", "boxes-layer", () => {
        map.getCanvas().style.cursor = "";
        popup.remove();
      });
    });
  }, [zonesGeo]);

  /* 步骤同步（样式加载后再执行） */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getLayer("boxes-layer") || !map.isStyleLoaded()) return;
    map.setLayoutProperty("boxes-layer", "visibility", step === 0 ? "none" : "visible");
    const src = map.getSource("boxes");
    if (src) src.setData(buildBoxes(step));
  }, [step]);

  /* ---------- JSX ---------- */
  return (
    <div style={{ display: "flex", position: "relative" }}>
      {/* Sidebar */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: sidebar ? 0 : -320,
          width: 300,
          height: "100vh",
          background: "rgba(255,255,255,0.27)",
          backdropFilter: "blur(14px)",
          padding: 16,
          transition: "left 0.3s",
          zIndex: 2,
          overflowY: "auto",
          boxSizing: "border-box"
        }}
      >
        <h3 style={{ margin: 0 }}>{steps[step].title}</h3>
        {steps[step].description && (
          <p style={{ marginTop: 8 }}>{steps[step].description}</p>
        )}

        <div style={{ marginTop: 18, display: "flex", justifyContent: "space-between" }}>
          <button onClick={() => setStep(p => Math.max(0, p - 1))}>Prev</button>
          <button onClick={() => setStep(p => Math.min(steps.length - 1, p + 1))}>Next</button>
        </div>

        {step > 0 && (
          <p style={{ marginTop: 12, fontSize: 12, opacity: 0.7 }}>
            Bars normalized (min-max) per feature
          </p>
        )}
      </div>

      {/* Toggle */}
      <button
        onClick={() => setSidebar(!sidebar)}
        style={{
          position: "absolute",
          top: "50%",
          left: sidebar ? 300 : 0,
          transform: "translateY(-50%)",
          zIndex: 3,
          background: "rgba(255,255,255,0.4)",
          border: "1px solid rgba(0,0,0,0.15)",
          borderRadius: sidebar ? "0 6px 6px 0" : "6px 0 0 6px",
          padding: "4px 6px",
          cursor: "pointer"
        }}
        title={sidebar ? "Hide panel" : "Show panel"}
      >
        {sidebar ? "◀" : "▶"}
      </button>

      {/* Map */}
      <div ref={containerRef} style={{ width: "100%", height: "100vh" }} />
    </div>
  );
}
