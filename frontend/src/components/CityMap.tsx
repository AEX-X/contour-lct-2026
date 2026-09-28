import {
  BellRinging,
  Check,
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

type MarkerState = "normal" | "attention" | "critical" | "forecast" | "no_data";

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
    top: Math.min(88, Math.max(12, top)),
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
  return (
    <div className="city-map" role="group" aria-label="Демонстрационная карта объектов Москвы">
      {facilities.map((facility, index) => {
        const state = getMarkerState(facility, risks, incidents, asOf);
        const position = getPosition(facility, index);
        const selected = selectedId === facility.id;
        return (
          <div key={facility.id}>
            <button
              className={`map-marker map-marker--${state}`}
              type="button"
              style={{ left: `${position.left}%`, top: `${position.top}%` }}
              aria-label={`${facility.name}. ${markerLabels[state]}. ${facility.address}`}
              aria-pressed={selected}
              onClick={() => onSelect(facility.id)}
            >
              <MarkerIcon state={state} />
            </button>
            {selected ? (
              <span
                className="map-label"
                style={{ left: `${position.left}%`, top: `${position.top}%` }}
              >
                {facility.name}
              </span>
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
      <span className="map-demo-label">Демо-геометрия</span>
    </div>
  );
}
