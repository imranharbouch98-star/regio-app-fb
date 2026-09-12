import { useEffect, useMemo, useState, useRef } from "react";
import { MapContainer, TileLayer, GeoJSON, CircleMarker, Tooltip, ZoomControl, Pane, useMapEvents } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./App.css";
import Login from "./Login.jsx";
import { firebaseEnabled, subscribeToOverrides, saveOverridesShared, reconnectFirebase } from "./firebase.js";

import advisorPostcodesBase from "./data/advisor-postcodes.json";
import advisorsHome from "./data/advisors-home.json";
import postcodeNames from "./data/postcode-names.json";

import advisorPostcodesAlkmaar from "./data/advisor-postcodes-alkmaar.json";
import advisorsHomeAlkmaar from "./data/advisors-home-alkmaar.json";
import postcodeNamesAlkmaar from "./data/postcode-names-alkmaar.json";

import advisorIconsBase from "./data/advisor-icons.json";
import advisorIconsAlkmaar from "./data/advisor-icons-alkmaar.json";

const AUTH_KEY = "map-auth-ok";

const COLORS = [
  "#D85A30", "#378ADD", "#639922", "#7F77DD", "#D4537E",
  "#BA7517", "#1D9E75", "#888780", "#e24b4a", "#0c447c",
];

const SEARCH_COLORS = ["#EF9F27", "#3B8BD4", "#639922", "#D4537E", "#8B5CF6", "#0c447c"];
const MAX_SEARCH_FIELDS = SEARCH_COLORS.length;

const ICON_TYPES = [
  { key: "prio", emoji: "👑", label: "Prioriteit", bold: true },
  { key: "airco", emoji: "🌬️", label: "Airco" },
  { key: "zp", emoji: "☀️", label: "Zonnepanelen" },
  { key: "wpb", emoji: "💧", label: "Warmtepompboiler" },
  { key: "wplw", emoji: "🔥", label: "Warmtepomp lucht-water" },
];

// elk departement is volledig apart: eigen kaartdata, eigen adviseurs, eigen
// opslag-sleutel. Ze delen geen data en botsen dus nooit met elkaar.
const DEPARTMENTS = [
  {
    id: "vlaanderen",
    label: "Vlaanderen & Zuid-NL",
    postcodesUrl: "/data/postcodes.geojson",
    advisorPostcodesBase,
    advisorsHome,
    postcodeNames,
    storageKey: "advisor-postcode-overrides",
    firebasePath: "advisorPostcodeOverrides",
    firebaseProfilePath: "advisorProfileOverrides",
    advisorIconsBase,
    iconTypes: ICON_TYPES,
    center: [50.95, 4.6],
    zoom: 8,
  },
  {
    id: "alkmaar",
    label: "Alkmaar",
    postcodesUrl: "/data/postcodes-alkmaar.geojson",
    advisorPostcodesBase: advisorPostcodesAlkmaar,
    advisorsHome: advisorsHomeAlkmaar,
    postcodeNames: postcodeNamesAlkmaar,
    storageKey: "advisor-postcode-overrides-alkmaar",
    firebasePath: "advisorPostcodeOverridesAlkmaar",
    firebaseProfilePath: "advisorProfileOverridesAlkmaar",
    advisorIconsBase: advisorIconsAlkmaar,
    iconTypes: [],
    center: [52.6, 5.0],
    zoom: 8,
  },
];

function colorForIndex(i) {
  return COLORS[i % COLORS.length];
}

function loadOverrides(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveOverridesLocal(key, overrides) {
  localStorage.setItem(key, JSON.stringify(overrides));
}

function centroidOfRing(ring) {
  let sx = 0, sy = 0;
  ring.forEach(([x, y]) => { sx += x; sy += y; });
  return [sy / ring.length, sx / ring.length];
}

function MapEvents({ onZoom }) {
  const map = useMapEvents({
    zoomend: () => onZoom(map.getZoom()),
  });
  return null;
}

export default function App() {
  const [authed, setAuthed] = useState(() => sessionStorage.getItem(AUTH_KEY) === "1");
  const [activeDept, setActiveDept] = useState(DEPARTMENTS[0].id);

  if (!authed) {
    return <Login onSuccess={() => { sessionStorage.setItem(AUTH_KEY, "1"); setAuthed(true); }} />;
  }

  const dept = DEPARTMENTS.find((d) => d.id === activeDept);

  return (
    <div className="app-shell">
      <div className="dept-tabs">
        {DEPARTMENTS.map((d) => (
          <button
            key={d.id}
            className={d.id === activeDept ? "dept-tab active" : "dept-tab"}
            onClick={() => setActiveDept(d.id)}
          >
            {d.label}
          </button>
        ))}
      </div>
      <DeptMap key={dept.id} config={dept} />
    </div>
  );
}

function DeptMap({ config }) {
  const {
    postcodesUrl, advisorPostcodesBase, advisorsHome, postcodeNames,
    storageKey, firebasePath, firebaseProfilePath, advisorIconsBase,
    center, zoom: initialZoom, iconTypes,
  } = config;

  const [postcodesGeo, setPostcodesGeo] = useState(null);
  const [selected, setSelected] = useState(null);
  const [editorFor, setEditorFor] = useState(null);
  const [overrides, setOverrides] = useState(() => loadOverrides(storageKey));
  const [profileOverrides, setProfileOverrides] = useState(() => loadOverrides(storageKey + "-profile"));
  const [draft, setDraft] = useState("");
  const [saved, setSaved] = useState(false);
  const [profilePostcodeDraft, setProfilePostcodeDraft] = useState("");
  const [profileIconsDraft, setProfileIconsDraft] = useState([]);
  const [profileSaved, setProfileSaved] = useState(false);
  const [zoom, setZoom] = useState(initialZoom);
  const [searchFields, setSearchFields] = useState(["", ""]);
  const [activeSearch, setActiveSearch] = useState([]);
  const [searchError, setSearchError] = useState("");
  const mapRef = useRef(null);
  const homeRenderer = useMemo(() => L.svg({ pane: "homes" }), []);
  const advisorLayerRef = useRef(null);
  const searchLayerRef = useRef(null);
  const [popupPos, setPopupPos] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (firebaseEnabled) {
      const unsubscribe = subscribeToOverrides(firebasePath, (shared) => setOverrides(shared));
      return unsubscribe;
    }
  }, [firebasePath]);

  useEffect(() => {
    if (firebaseEnabled) {
      const unsubscribe = subscribeToOverrides(firebaseProfilePath, (shared) => setProfileOverrides(shared));
      return unsubscribe;
    }
  }, [firebaseProfilePath]);

  const advisorPostcodes = useMemo(() => {
    return { ...advisorPostcodesBase, ...overrides };
  }, [advisorPostcodesBase, overrides]);

  const advisorNames = useMemo(
    () => Object.keys(advisorPostcodes).sort((a, b) => a.localeCompare(b)),
    [advisorPostcodes]
  );

  const advisorProfiles = useMemo(() => {
    const result = {};
    advisorNames.forEach((name) => {
      const base = {
        postcode: advisorsHome[name]?.postcode || "",
        icons: advisorIconsBase[name] || [],
      };
      const override = profileOverrides[name];
      result[name] = override
        ? { postcode: override.postcode ?? base.postcode, icons: override.icons ?? base.icons }
        : base;
    });
    return result;
  }, [advisorNames, advisorsHome, advisorIconsBase, profileOverrides]);

  useEffect(() => {
    fetch(postcodesUrl)
      .then((r) => r.json())
      .then((geo) => {
        geo.features = geo.features.filter((f) => f && f.geometry);
        setPostcodesGeo(geo);
      });
  }, [postcodesUrl]);

  useEffect(() => {
    const handleReconnect = () => {
      reconnectFirebase();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        handleReconnect();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("online", handleReconnect);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("online", handleReconnect);
    };
  }, []);

  const postcodeToCentroid = useMemo(() => {
    if (!postcodesGeo) return {};
    const sums = {};
    postcodesGeo.features.forEach((f) => {
      const pc = f.properties.postcode;
      const rings = f.geometry.type === "Polygon" ? [f.geometry.coordinates[0]] : f.geometry.coordinates.map((p) => p[0]);
      rings.forEach((ring) => {
        const [lat, lng] = centroidOfRing(ring);
        if (!sums[pc]) sums[pc] = { lat: 0, lng: 0, n: 0 };
        sums[pc].lat += lat;
        sums[pc].lng += lng;
        sums[pc].n += 1;
      });
    });
    const out = {};
    Object.entries(sums).forEach(([pc, s]) => { out[pc] = [s.lat / s.n, s.lng / s.n]; });
    return out;
  }, [postcodesGeo]);

  const availablePostcodes = useMemo(() => new Set(Object.keys(postcodeToCentroid)), [postcodeToCentroid]);

  const homeCoords = useMemo(() => {
    const coords = {};
    Object.entries(advisorsHome).forEach(([name, info]) => {
      if (postcodeToCentroid[info.postcode]) coords[name] = postcodeToCentroid[info.postcode];
    });
    return coords;
  }, [postcodeToCentroid, advisorsHome]);

  const zoneLabels = useMemo(() => {
    const groups = {};
    Object.entries(postcodeToCentroid).forEach(([pc, c]) => {
      const zoneKey = pc.slice(0, 2);
      if (!groups[zoneKey]) groups[zoneKey] = [];
      groups[zoneKey].push(c);
    });
    return Object.entries(groups).map(([zoneKey, pts]) => {
      const lat = pts.reduce((s, p) => s + p[0], 0) / pts.length;
      const lng = pts.reduce((s, p) => s + p[1], 0) / pts.length;
      return { zone: zoneKey, lat, lng };
    });
  }, [postcodeToCentroid]);

  const postcodeLabels = useMemo(() => {
    return Object.entries(postcodeToCentroid).map(([pc, c]) => ({ pc, lat: c[0], lng: c[1] }));
  }, [postcodeToCentroid]);

  const showPostcodeLabels = zoom >= 10;

  const selectedPostcodeSet = useMemo(() => {
    if (!selected) return null;
    return new Set(advisorPostcodes[selected] || []);
  }, [selected, advisorPostcodes]);

  const colorIndex = selected ? advisorNames.indexOf(selected) : 0;
  const highlightColor = colorForIndex(colorIndex);

  const styleFn = (feature) => {
    const isActive = selectedPostcodeSet && selectedPostcodeSet.has(feature.properties.postcode);
    if (isActive) {
      return { fillColor: highlightColor, fillOpacity: 0.4, color: highlightColor, weight: 1.5 };
    }
    return { fillColor: "#888", fillOpacity: 0, color: "#999", weight: 0.3 };
  };

  const searchStyleFn = (feature) => {
    const hit = activeSearch.find((s) => s.postcode === feature.properties.postcode);
    if (hit) {
      return { fillColor: hit.color, fillOpacity: 0.5, color: hit.color, weight: 3 };
    }
    return { fillOpacity: 0, opacity: 0, weight: 0 };
  };

  useEffect(() => {
    if (advisorLayerRef.current) advisorLayerRef.current.setStyle(styleFn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPostcodeSet, highlightColor]);

  useEffect(() => {
    if (searchLayerRef.current) searchLayerRef.current.setStyle(searchStyleFn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSearch]);

  function selectAdvisor(name) {
    setSelected((prev) => (prev === name ? null : name));
  }

  function openEditor(name, e) {
  setSelected(name);
  if (editorFor === name) {
    setEditorFor(null);
    return;
  }

  const rect = e.currentTarget.getBoundingClientRect();
  const popupWidth = 320;
  const popupMaxHeight = window.innerHeight * 0.8;

  let left = rect.right + 12;
  if (left + popupWidth > window.innerWidth) {
    left = rect.left - popupWidth - 12;
  }

  let top = rect.top;
  if (top + popupMaxHeight > window.innerHeight) {
    top = Math.max(12, window.innerHeight - popupMaxHeight - 12);
  }

  setPopupPos({ top, left });
  setEditorFor(name);
  setDraft((advisorPostcodes[name] || []).join(", "));
  setProfilePostcodeDraft(advisorProfiles[name]?.postcode || "");
  setProfileIconsDraft(advisorProfiles[name]?.icons || []);
  setSaved(false);
  setProfileSaved(false);
}

  function toggleProfileIcon(key) {
    setProfileIconsDraft((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );
  }

  function handleProfileSave() {
    const pc = profilePostcodeDraft.trim();
    const next = { ...profileOverrides, [editorFor]: { postcode: pc, icons: profileIconsDraft } };
    setProfileOverrides(next);
    if (firebaseEnabled) {
      saveOverridesShared(firebaseProfilePath, next);
    } else {
      saveOverridesLocal(storageKey + "-profile", next);
    }
    setProfileSaved(true);
    setTimeout(() => setProfileSaved(false), 1500);
  }

  function handleSave() {
    const list = draft
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^\d{4}$/.test(s));
    const unique = Array.from(new Set(list)).sort();
    const next = { ...overrides, [editorFor]: unique };
    setOverrides(next);
    if (firebaseEnabled) {
      saveOverridesShared(firebasePath, next);
    } else {
      saveOverridesLocal(storageKey, next);
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  function handleReset() {
    const ok = window.confirm(
      "Alle lokale aanpassingen voor dit tabblad wissen en teruggaan naar de standaardgegevens?"
    );
    if (!ok) return;
    localStorage.removeItem(storageKey);
    localStorage.removeItem(storageKey + "-profile");
    setOverrides({});
    setProfileOverrides({});
    if (firebaseEnabled) {
      saveOverridesShared(firebasePath, {});
      saveOverridesShared(firebaseProfilePath, {});
    }
    setSelected(null);
    setEditorFor(null);
    setDraft("");
  }

  const namesToPostcodes = useMemo(() => {
    return Object.entries(postcodeNames).map(([pc, name]) => ({ pc, name, lower: name.toLowerCase() }));
  }, [postcodeNames]);

  function runSearch() {
    const entries = searchFields.map((s) => s.trim()).filter(Boolean);
    const results = [];
    const missing = [];
    entries.forEach((entry, i) => {
      const isPostcode = /^\d{4}$/.test(entry);
      let matchedPostcodes = [];
      if (isPostcode && availablePostcodes.has(entry)) {
        matchedPostcodes = [entry];
      } else if (!isPostcode) {
        const needle = entry.toLowerCase();
        matchedPostcodes = namesToPostcodes.filter((n) => n.lower.includes(needle)).map((n) => n.pc);
      }
      if (matchedPostcodes.length) {
        matchedPostcodes.forEach((pc) => {
          const advisors = advisorNames.filter((name) => (advisorPostcodes[name] || []).includes(pc));
          results.push({ postcode: pc, name: postcodeNames[pc], color: SEARCH_COLORS[i], advisors });
        });
      } else {
        missing.push(entry);
      }
    });
    setActiveSearch(results);
    setSearchError(missing.length ? `Niet gevonden: ${missing.join(", ")}` : "");

    if (results.length && mapRef.current) {
      const points = results.map((r) => postcodeToCentroid[r.postcode]).filter(Boolean);
      if (points.length === 1) {
        mapRef.current.flyTo(points[0], 12);
      } else if (points.length > 1) {
        mapRef.current.flyToBounds(points, { padding: [60, 60], maxZoom: 12 });
      }
    }
  }

  function updateSearchField(i, value) {
    setSearchFields((prev) => prev.map((v, idx) => (idx === i ? value : v)));
  }

  function addSearchField() {
    setSearchFields((prev) => (prev.length < MAX_SEARCH_FIELDS ? [...prev, ""] : prev));
  }

  function clearSearch() {
    setActiveSearch([]);
    setSearchFields(["", ""]);
    setSearchError("");
  }

  const advisorSearchHighlight = useMemo(() => {
    const map = {};
    activeSearch.forEach(({ color, advisors }) => {
      advisors.forEach((name) => {
        if (!map[name]) map[name] = [];
        map[name].push(color);
      });
    });
    return map;
  }, [activeSearch]);

  const unknownInDraft = draft
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && (!/^\d{4}$/.test(s) || !availablePostcodes.has(s)));

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>Adviseurs</h1>
        <p className={firebaseEnabled ? "sync-status live" : "sync-status local"}>
          {firebaseEnabled ? "● Live gedeeld met iedereen" : "○ Enkel lokaal (niet gedeeld)"}
        </p>
        <button className="reset-btn" onClick={handleReset} title="Wist eventuele lokale aanpassingen en gaat terug naar de standaardgegevens">
          ↺ Herstel naar standaardgegevens
        </button>
        <p className="hint">Klik op een naam om de regio te tonen, dubbelklik om te bewerken</p>
        <ul className="advisor-list">
          {advisorNames.map((name, i) => {
            const searchHit = advisorSearchHighlight[name];
            const isPrio = iconTypes.some((ic) => ic.bold && advisorProfiles[name]?.icons?.includes(ic.key));
            return (
              <li key={name} style={{ position: "relative" }}>
                <button
                  className={selected === name ? "active" : ""}
                  style={
                    searchHit
                      ? { borderLeft: `4px solid ${searchHit[0]}`, background: searchHit[0] + "1a" }
                      : selected === name
                      ? { borderColor: colorForIndex(i), background: colorForIndex(i) + "22" }
                      : {}
                  }
                  onClick={() => selectAdvisor(name)}
                  onDoubleClick={(e) => openEditor(name, e)}
                >
                  <span className="dot" style={{ background: colorForIndex(i) }} />
                  <span style={isPrio ? { fontWeight: 700 } : {}}>{name}</span>
                  {advisorProfiles[name]?.postcode && (
                    <span className="home-pc">{advisorProfiles[name].postcode}</span>
                  )}
                  {iconTypes.map((ic, idx) =>
                    advisorProfiles[name]?.icons?.includes(ic.key) && (
                      <span key={idx} title={ic.label}>{ic.emoji}</span>
                    )
                  )}
                  {overrides[name] && <span className="edited-mark" title="Aangepast">●</span>}
                </button>

                  {editorFor === name && (
                 <>
                  <div className="editor-popup-backdrop" onClick={() => setEditorFor(null)} />
                  <div
                   className="editor editor-popup"
                  style={{ top: popupPos.top, left: popupPos.left, borderLeft: `4px solid ${colorForIndex(i)}` }}
                     >
                    <div className="editor-popup-header">
                      <h2>{name}</h2>
                      <button className="editor-close" onClick={() => setEditorFor(null)}>✕</button>
                    </div>

                    <div className="profile-editor">
                      <p className="hint">Thuis-postcode</p>
                      <input
                        type="text"
                        value={profilePostcodeDraft}
                        onChange={(e) => setProfilePostcodeDraft(e.target.value)}
                        placeholder="bv. 3600"
                        maxLength={4}
                      />
                      {iconTypes.length > 0 && (
                        <>
                          <p className="hint">Badges</p>
                          <div className="icon-checkboxes">
                            {iconTypes.map((ic) => (
                              <label key={ic.key} className="icon-checkbox">
                                <input
                                  type="checkbox"
                                  checked={profileIconsDraft.includes(ic.key)}
                                  onChange={() => toggleProfileIcon(ic.key)}
                                />
                                <span>{ic.emoji} {ic.label}</span>
                              </label>
                            ))}
                          </div>
                        </>
                      )}
                      <button className="save-btn" onClick={handleProfileSave}>
                        {profileSaved ? "Opgeslagen ✓" : "Profiel opslaan"}
                      </button>
                    </div>

                    <p className="hint">Postcodes, gescheiden door komma</p>
                    <textarea rows={6} value={draft} onChange={(e) => setDraft(e.target.value)} />
                    {unknownInDraft.length > 0 && (
                      <p className="warning">Onbekend of ongeldig: {unknownInDraft.join(", ")}</p>
                    )}
                    <div className="editor-actions">
                      <button className="save-btn" onClick={handleSave}>
                        {saved ? "Opgeslagen ✓" : "Opslaan"}
                      </button>
                      <span className="count">{draft.split(",").map((s) => s.trim()).filter(Boolean).length} postcodes</span>
                    </div>
                  </div>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      </aside>

      <main className="map-wrap">
        <div className="search-bar">
          {searchFields.map((val, i) => (
            <input
              key={i}
              type="text"
              placeholder={i === 0 ? "Postcode of plaats, bv. 3600 of Genk" : `Postcode of plaats ${i + 1} (optioneel)`}
              value={val}
              onChange={(e) => updateSearchField(i, e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && runSearch()}
              style={{ borderLeft: `3px solid ${SEARCH_COLORS[i]}` }}
            />
          ))}
          <div className="search-actions">
            <button className="search-btn" onClick={runSearch}>Zoek</button>
            {searchFields.length < MAX_SEARCH_FIELDS && (
              <button className="search-add" onClick={addSearchField} title="Nog een postcode toevoegen">+ veld</button>
            )}
            {activeSearch.length > 0 && (
              <button className="search-clear" onClick={clearSearch}>Wissen</button>
            )}
          </div>
          {searchError && <span className="search-error">{searchError}</span>}
          {activeSearch.length > 0 && (
            <div className="search-results">
              {activeSearch.map(({ postcode, name, color, advisors }) => (
                <div key={postcode} className="search-result-row">
                  <span className="search-result-pc" style={{ color }}>{postcode}{name ? ` · ${name}` : ""}</span>
                  <span className="search-result-names">
                    {advisors.length
                      ? advisors.map((n, idx) => {
                          const isPrio = iconTypes.some((ic) => ic.bold && advisorProfiles[n]?.icons?.includes(ic.key));
                          return (
                            <span key={n} style={isPrio ? { fontWeight: 700 } : {}}>
                              {n}{idx < advisors.length - 1 ? ", " : ""}
                            </span>
                          );
                        })
                      : "niemand toegewezen"}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <MapContainer ref={mapRef} center={center} zoom={initialZoom} zoomControl={false} style={{ height: "100%", width: "100%" }}>
          <ZoomControl position="topright" />
          <TileLayer
            attribution="&copy; OpenStreetMap contributors"
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <MapEvents onZoom={setZoom} />

          {postcodesGeo && (
            <GeoJSON ref={advisorLayerRef} data={postcodesGeo} style={styleFn} />
          )}
          {postcodesGeo && (
            <GeoJSON ref={searchLayerRef} data={postcodesGeo} style={searchStyleFn} />
          )}

          {!showPostcodeLabels &&
            zoneLabels.map(({ zone, lat, lng }) => (
              <CircleMarker key={"zone-" + zone} center={[lat, lng]} radius={1} pathOptions={{ opacity: 0, fillOpacity: 0 }}>
                <Tooltip permanent direction="center" className="zone-label">{zone}</Tooltip>
              </CircleMarker>
            ))}

          {showPostcodeLabels &&
            postcodeLabels.map(({ pc, lat, lng }) => (
              <CircleMarker key={"pc-" + pc} center={[lat, lng]} radius={1} pathOptions={{ opacity: 0, fillOpacity: 0 }}>
                <Tooltip permanent direction="center" className="postcode-label">{pc}</Tooltip>
              </CircleMarker>
            ))}

          <Pane name="homes" style={{ zIndex: 700 }}>
            {Object.entries(homeCoords).map(([name, latlng]) => (
              <CircleMarker
                key={name}
                center={latlng}
                renderer={homeRenderer}
                radius={selected === name ? 7 : 4}
                pathOptions={{
                  color: "#222",
                  weight: 1,
                  fillColor: selected === name ? highlightColor : "#444",
                  fillOpacity: 1,
                }}
                eventHandlers={{ click: () => selectAdvisor(name) }}
              >
                <Tooltip>
                  {name} · {postcodeNames[advisorsHome[name]?.postcode] || advisorsHome[name]?.city} ({advisorsHome[name]?.postcode})
                </Tooltip>
              </CircleMarker>
            ))}
          </Pane>
        </MapContainer>
      </main>
    </div>
  );
}