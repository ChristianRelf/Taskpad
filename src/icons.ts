/**
 * One icon set, one geometry: 16px box, 1.6 stroke, round caps and joins,
 * drawn in currentColor so icons inherit the row's text colour.
 */
const NS = "http://www.w3.org/2000/svg";

function icon(paths: string[], opts: { fill?: string[] } = {}): SVGElement {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.6");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const d of paths) {
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  for (const d of opts.fill ?? []) {
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "currentColor");
    path.setAttribute("stroke", "none");
    svg.appendChild(path);
  }
  return svg;
}

export const Icons = {
  menu: () => icon(["M2.5 4.5h11", "M2.5 8h11", "M2.5 11.5h11"]),
  plus: () => icon(["M8 3.5v9", "M3.5 8h9"]),
  back: () => icon(["M9.75 3.5 5.25 8l4.5 4.5"]),
  chevronRight: () => icon(["M6 3.75 10.25 8 6 12.25"]),
  chevronDown: () => icon(["M3.75 6 8 10.25 12.25 6"]),
  grip: () => icon([], {
    fill: [
      "M6 3.1a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2Z",
      "M10 3.1a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2Z",
      "M6 6.9a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2Z",
      "M10 6.9a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2Z",
      "M6 10.7a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2Z",
      "M10 10.7a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2Z",
    ],
  }),
  more: () => icon([], {
    fill: [
      "M3.2 6.9a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2Z",
      "M8 6.9a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2Z",
      "M12.8 6.9a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2Z",
    ],
  }),
  check: () => icon(["M3.25 8.4 6.4 11.5l6.35-7"]),
  close: () => icon(["M4 4l8 8", "M12 4l-8 8"]),
  calendar: () => icon([
    "M3 4.75h10a.75.75 0 0 1 .75.75v7A.75.75 0 0 1 13 13.25H3a.75.75 0 0 1-.75-.75v-7A.75.75 0 0 1 3 4.75Z",
    "M5.25 2.75v3",
    "M10.75 2.75v3",
    "M2.25 7.75h11.5",
  ]),
  tag: () => icon([
    "M2.75 7.2V3.5a.75.75 0 0 1 .75-.75h3.7a.75.75 0 0 1 .53.22l5.05 5.05a.75.75 0 0 1 0 1.06l-3.7 3.7a.75.75 0 0 1-1.06 0L2.97 7.73a.75.75 0 0 1-.22-.53Z",
    "M5.6 5.6h.01",
  ]),
  note: () => icon(["M4 3.5h8", "M4 6.5h8", "M4 9.5h5.5"]),
  indent: () => icon(["M7 4.5h6.5", "M7 8h6.5", "M7 11.5h6.5", "M2.5 6 4.75 8 2.5 10"]),
  outdent: () => icon(["M7 4.5h6.5", "M7 8h6.5", "M7 11.5h6.5", "M4.75 6 2.5 8l2.25 2"]),
  trash: () => icon([
    "M2.75 4.25h10.5",
    "M6.25 4.25V3a.75.75 0 0 1 .75-.75h2a.75.75 0 0 1 .75.75v1.25",
    "M4.25 4.25 4.8 13a.75.75 0 0 0 .75.7h4.9a.75.75 0 0 0 .75-.7l.55-8.75",
  ]),
  download: () => icon(["M8 2.75v7", "M5 7l3 3 3-3", "M3 12.75h10"]),
  upload: () => icon(["M8 10.25v-7", "M5 6l3-3 3 3", "M3 12.75h10"]),
  account: () => icon([
    "M8 8.25a2.75 2.75 0 1 0 0-5.5 2.75 2.75 0 0 0 0 5.5Z",
    "M2.9 13.25a5.25 5.25 0 0 1 10.2 0",
  ]),
  keyboard: () => icon([
    "M2.25 4.25h11.5a.5.5 0 0 1 .5.5v6.5a.5.5 0 0 1-.5.5H2.25a.5.5 0 0 1-.5-.5v-6.5a.5.5 0 0 1 .5-.5Z",
    "M5 9.75h6",
  ], { fill: ["M4 6.4h1.1v1.1H4Z", "M6.2 6.4h1.1v1.1H6.2Z", "M8.7 6.4h1.1v1.1H8.7Z", "M10.9 6.4H12v1.1h-1.1Z"] }),
  link: () => icon([
    "M6.6 9.4a2.4 2.4 0 0 0 3.4 0l2-2a2.4 2.4 0 0 0-3.4-3.4l-.7.7",
    "M9.4 6.6a2.4 2.4 0 0 0-3.4 0l-2 2a2.4 2.4 0 0 0 3.4 3.4l.7-.7",
  ]),
  globe: () => icon([
    "M8 13.75A5.75 5.75 0 1 0 8 2.25a5.75 5.75 0 0 0 0 11.5Z",
    "M2.4 8h11.2",
    "M8 2.25c1.5 1.6 2.3 3.6 2.3 5.75S9.5 12.15 8 13.75C6.5 12.15 5.7 10.15 5.7 8S6.5 3.85 8 2.25Z",
  ]),
  info: () => icon(["M8 13.75A5.75 5.75 0 1 0 8 2.25a5.75 5.75 0 0 0 0 11.5Z", "M8 7.4v3.6", "M8 5.1h.01"]),
};

export type IconName = keyof typeof Icons;
