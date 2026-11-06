/**
 * Charts of A2UI widgets, drawn as inline SVG when the widget is built.
 *
 * Exports:
 * - `ChartData`: the computed labels and series of one chart.
 * - `renderChartSvg`: the SVG of a bar, line or pie chart.
 *
 * Key constructs:
 * - Drawn on the server, so the widget carries no chart library (Telegram bundles none) and no script.
 * - Coordinates are rounded to whole units of a 300 × 160 view box: SVG paths are what a chart costs in
 *   Telegram's 4 KB, and the bubble scales the view box to its width anyway.
 * - Series colours: the theme's button colour first, then fixed colours readable in both themes.
 */

export interface ChartData {
  readonly kind: "bar" | "line" | "pie";
  readonly labels: readonly string[];
  readonly series: readonly { readonly name: string; readonly values: readonly number[] }[];
  readonly unit: string;
}

const WIDTH = 300;
const HEIGHT = 160;
const LEFT = 4;
const BOTTOM = 18;
const TOP = 12;
const COLORS = ["var(--tg-theme-button-color)", "#e0952a", "#2e9d57", "#8f63d6"];
const PIE_COLORS = ["var(--tg-theme-button-color)", "#e0952a", "#2e9d57", "#8f63d6", "#d1495b", "#3fa7c2", "#a3a3a3"];

function escapeXml(text: string): string {
  return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");
}

function short(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${Math.round(value / 100_000) / 10}м`;
  if (abs >= 10_000) return `${Math.round(value / 1_000)}к`;
  return String(Math.round(value * 10) / 10).replace(".", ",");
}

function legend(series: ChartData["series"]): string {
  if (series.length < 2) return "";
  return `<div class="r cp">${series.map((item, index) => `<span><b style="color:${COLORS[index]}">●</b> ${escapeXml(item.name)}</span>`).join("")}</div>`;
}

function axisLabels(labels: readonly string[], step: number, offset: number): string {
  const every = Math.max(1, Math.ceil(labels.length / 8));
  return labels.map((label, index) => index % every === 0
    ? `<text x="${Math.round(LEFT + offset + index * step)}" y="${HEIGHT - 4}" text-anchor="middle">${escapeXml(label.slice(0, 8))}</text>`
    : "").join("");
}

function bars(data: ChartData): string {
  const max = Math.max(...data.series.flatMap((item) => item.values), 0) || 1;
  const plot = HEIGHT - BOTTOM - TOP;
  const step = (WIDTH - LEFT * 2) / data.labels.length;
  const width = Math.max(2, Math.floor((step * 0.7) / data.series.length));
  const rects = data.labels.map((_, labelIndex) => data.series.map((item, seriesIndex) => {
    const value = Math.max(0, item.values[labelIndex] ?? 0);
    const height = Math.round((value / max) * plot);
    const x = Math.round(LEFT + labelIndex * step + (step - width * data.series.length) / 2 + seriesIndex * width);
    const top = HEIGHT - BOTTOM - height;
    const caption = data.series.length === 1 && data.labels.length <= 12
      ? `<text x="${x + Math.round(width / 2)}" y="${top - 2}" text-anchor="middle">${short(value)}</text>`
      : "";
    return `<rect x="${x}" y="${top}" width="${width}" height="${height}" rx="2" fill="${COLORS[seriesIndex]}"/>${caption}`;
  }).join("")).join("");
  return `${rects}${axisLabels(data.labels, step, step / 2)}`;
}

function lines(data: ChartData): string {
  const values = data.series.flatMap((item) => item.values);
  const max = Math.max(...values);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const plot = HEIGHT - BOTTOM - TOP;
  const step = data.labels.length > 1 ? (WIDTH - LEFT * 2 - 16) / (data.labels.length - 1) : 0;
  const paths = data.series.map((item, seriesIndex) => {
    const points = item.values.map((value, index) => `${Math.round(LEFT + 8 + index * step)},${Math.round(TOP + plot - ((value - min) / span) * plot)}`);
    return `<polyline points="${points.join(" ")}" fill="none" stroke="${COLORS[seriesIndex]}" stroke-width="2" stroke-linejoin="round"/>`;
  }).join("");
  const last = data.series.length === 1 ? data.series[0]!.values.at(-1) : undefined;
  const tail = last === undefined ? "" : `<text x="${WIDTH - LEFT}" y="${TOP - 2}" text-anchor="end">${short(last)}${escapeXml(data.unit)}</text>`;
  return `${paths}${tail}${axisLabels(data.labels, step, 8)}`;
}

function pie(data: ChartData): string {
  const values = data.series[0]!.values.map((value) => Math.max(0, value));
  const total = values.reduce((sum, value) => sum + value, 0) || 1;
  const cx = 80;
  const cy = HEIGHT / 2;
  const radius = 64;
  let angle = -Math.PI / 2;
  const slices = values.map((value, index) => {
    const share = value / total;
    const start = angle;
    angle += share * Math.PI * 2;
    const color = PIE_COLORS[index % PIE_COLORS.length];
    if (share >= 0.9999) return `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${color}"/>`;
    const large = share > 0.5 ? 1 : 0;
    const point = (at: number) => `${Math.round(cx + radius * Math.cos(at))},${Math.round(cy + radius * Math.sin(at))}`;
    return `<path d="M${cx},${cy}L${point(start)}A${radius},${radius} 0 ${large} 1 ${point(angle)}Z" fill="${color}"/>`;
  }).join("");
  const keys = data.labels.slice(0, 7).map((label, index) => {
    const y = 20 + index * 19;
    const percent = Math.round(((values[index] ?? 0) / total) * 100);
    return `<rect x="170" y="${y - 8}" width="9" height="9" rx="2" fill="${PIE_COLORS[index]}"/><text x="184" y="${y}">${escapeXml(label.slice(0, 14))} ${percent}%</text>`;
  }).join("");
  return `${slices}${keys}`;
}

export function renderChartSvg(data: ChartData, title: string | null): string {
  const body = data.kind === "bar" ? bars(data) : data.kind === "line" ? lines(data) : pie(data);
  const heading = title === null || title === "" ? "" : `<div class="t2">${escapeXml(title)}</div>`;
  return `<div class="c">${heading}<svg viewBox="0 0 ${WIDTH} ${HEIGHT}">${body}</svg>${data.kind === "pie" ? "" : legend(data.series)}</div>`;
}
