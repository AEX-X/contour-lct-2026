import {
  BellRinging,
  Check,
  Info,
  Question,
  Sparkle,
  Warning,
} from "@phosphor-icons/react";
import {
  deriveFacilityOperationalState,
  type Facility,
  type Incident,
  type RiskForecast,
} from "../domain";
import { useState } from "react";

type MarkerState = "normal" | "attention" | "critical" | "forecast" | "no_data";

export const CITY_MAP_MARKER_LIMIT = 20;

const fallbackPositions = [
  { left: 32, top: 32 },
  { left: 58, top: 28 },
  { left: 43, top: 49 },
  { left: 71, top: 53 },
  { left: 27, top: 64 },
  { left: 63, top: 72 },
  { left: 48, top: 78 },
  { left: 78, top: 34 },
];

function getMarkerState(
  facility: Facility,
  risks: RiskForecast[],
  incidents: Incident[],
  asOf: string,
): MarkerState {
  return deriveFacilityOperationalState(facility, risks, incidents, asOf).state;
}

function getPosition(facility: Facility, index: number) {
  if (!facility.position) return fallbackPositions[index % fallbackPositions.length]!;
  // The demo map is a schematic Moscow view rather than a georeferenced tile.
  // These bounds keep the supplied Moscow coordinates legible and spatially stable.
  const left = ((facility.position.lon - 37.45) / 0.35) * 100;
  const top = ((55.84 - facility.position.lat) / 0.18) * 100;
  return {
    left: Math.min(91, Math.max(9, left)),
    top: Math.min(88, Math.max(24, top)),
  };
}

function MarkerIcon({ state }: { state: MarkerState }) {
  if (state === "critical") return <Warning size={18} weight="fill" />;
  if (state === "forecast") return <Sparkle size={18} weight="fill" />;
  if (state === "attention") return <BellRinging size={18} weight="fill" />;
  if (state === "no_data") return <Question size={18} weight="bold" />;
  return <Check size={18} weight="bold" />;
}

const markerLabels: Record<MarkerState, string> = {
  normal: "Норма",
  attention: "Требует внимания",
  critical: "Подтверждённый инцидент",
  forecast: "Демонстрационный прогноз",
  no_data: "Нет данных",
};

interface CityMapProps {
  facilities: Facility[];
  risks: RiskForecast[];
  incidents: Incident[];
  asOf: string;
  selectedId: string | null;
  onSelect: (facilityId: string) => void;
}

export function CityMap({ facilities, risks, incidents, asOf, selectedId, onSelect }: CityMapProps) {
  const [expandedCluster, setExpandedCluster] = useState<string | null>(null);
  const statePriority: Record<MarkerState, number> = {
    critical: 5,
    forecast: 4,
    attention: 3,
    no_data: 2,
    normal: 1,
  };
  const visibleFacilities = facilities
    .map((facility, originalIndex) => ({
      facility,
      originalIndex,
      state: getMarkerState(facility, risks, incidents, asOf),
    }))
    .sort((left, right) => {
      if (left.facility.id === selectedId) return -1;
      if (right.facility.id === selectedId) return 1;
      return statePriority[right.state] - statePriority[left.state]
        || left.facility.name.localeCompare(right.facility.name, "ru");
    })
    .slice(0, CITY_MAP_MARKER_LIMIT);
  const clusters = Array.from(visibleFacilities.reduce((result, entry) => {
    const rawPosition = getPosition(entry.facility, entry.originalIndex);
    const column = Math.round(rawPosition.left / 14);
    const row = Math.round(rawPosition.top / 18);
    const key = `${column}:${row}`;
    const cluster = result.get(key) ?? {
      key,
      position: {
        left: Math.min(86, Math.max(14, column * 14)),
        top: Math.min(88, Math.max(24, row * 18)),
      },
      entries: [] as typeof visibleFacilities,
    };
    cluster.entries.push(entry);
    result.set(key, cluster);
    return result;
  }, new Map<string, {
    key: string;
    position: { left: number; top: number };
    entries: typeof visibleFacilities;
  }>()).values());

  return (
    <div className="city-map" role="group" aria-label="Демонстрационная карта объектов Москвы">
      <div className="map-scope-note" role="note">
        <Info size={20} weight="fill" aria-hidden="true" />
        <span>
          <strong>Демонстрационная геометрия</strong>
          <small>
            {visibleFacilities.length < facilities.length
              ? `Показаны ${visibleFacilities.length} из ${facilities.length} объектов. Сначала инциденты, риски и отклонения. Близкие точки объединены`
              : `Показаны все ${facilities.length} объектов по демонстрационным координатам. Близкие точки объединены`}
          </small>
        </span>
      </div>
      {clusters.map((cluster) => {
        const selectedEntry = cluster.entries.find(({ facility }) => facility.id === selectedId);
        const representative = selectedEntry ?? cluster.entries[0]!;
        const state = cluster.entries.reduce(
          (highest, entry) => statePriority[entry.state] > statePriority[highest] ? entry.state : highest,
          representative.state,
        );
        const selected = Boolean(selectedEntry);
        const isCluster = cluster.entries.length > 1;
        const menuId = `map-cluster-${cluster.key.replace(":", "-")}`;
        return (
          <div key={cluster.key}>
            <button
              className={`map-marker map-marker--${state}${isCluster ? " map-marker--cluster" : ""}`}
              type="button"
              style={{ left: `${cluster.position.left}%`, top: `${cluster.position.top}%` }}
              aria-label={isCluster
                ? `Группа из ${cluster.entries.length} объектов. ${selectedEntry ? `Выбран ${selectedEntry.facility.name}. ` : ""}Максимальный статус: ${markerLabels[state]}. Открыть список`
                : `${representative.facility.name}. ${markerLabels[state]}. ${representative.facility.address}`}
              aria-pressed={selected}
              aria-expanded={isCluster ? expandedCluster === cluster.key : undefined}
              aria-controls={isCluster ? menuId : undefined}
              onClick={() => {
                if (isCluster) {
                  setExpandedCluster((current) => current === cluster.key ? null : cluster.key);
                } else {
                  onSelect(representative.facility.id);
                }
              }}
            >
              {isCluster ? <span aria-hidden="true">{cluster.entries.length}</span> : <MarkerIcon state={state} />}
            </button>
            {selected ? (
              <span
                className="map-label"
                style={{ left: `${cluster.position.left}%`, top: `${cluster.position.top}%` }}
              >
                {selectedEntry?.facility.name}
              </span>
            ) : null}
            {isCluster && expandedCluster === cluster.key ? (
              <div
                className={`map-cluster-menu${cluster.position.left > 50 ? " map-cluster-menu--left" : ""}${cluster.position.top > 60 ? " map-cluster-menu--above" : ""}`}
                id={menuId}
                role="group"
                aria-label={`Объекты в группе: ${cluster.entries.length}`}
                style={{ left: `${cluster.position.left}%`, top: `${cluster.position.top}%` }}
              >
                <strong>Объекты в этой точке</strong>
                <ul>
                  {cluster.entries.map((entry) => (
                    <li key={entry.facility.id}>
                      <button
                        type="button"
                        aria-current={entry.facility.id === selectedId ? "true" : undefined}
                        onClick={() => {
                          onSelect(entry.facility.id);
                          setExpandedCluster(null);
                        }}
                      >
                        <span>{entry.facility.name}</span>
                        <small>{markerLabels[entry.state]}</small>
                      </button>
                    </li>
                  ))}
                </ul>
                <small>Полный перечень доступен в представлении «Список»</small>
              </div>
            ) : null}
          </div>
        );
      })}
      <div className="map-legend" aria-label="Легенда карты">
        {([
          ["normal", "Норма"],
          ["attention", "Внимание"],
          ["forecast", "Прогноз"],
          ["critical", "Инцидент"],
          ["no_data", "Нет данных"],
        ] as const).map(([state, label]) => (
          <span className="map-legend__item" key={state}>
            <span className={`map-legend__dot map-marker--${state}`} aria-hidden="true" />
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}
