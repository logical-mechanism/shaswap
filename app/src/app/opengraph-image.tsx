import { ImageResponse } from "next/og";

// Branded social/share card (also used for Twitter via the same file convention).
export const alt = "ShaSwap — a cozy batch swap on Cardano";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// A static (animation-free) Pip, inlined as an SVG data URI for Satori to rasterize.
const PIP_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">
<defs>
<linearGradient id="f" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#cdb9f7"/><stop offset="1" stop-color="#b193ee"/></linearGradient>
<linearGradient id="fd" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#b89bf1"/><stop offset="1" stop-color="#a585e9"/></linearGradient>
<radialGradient id="fr" cx="0.5" cy="0.38" r="0.75"><stop offset="0" stop-color="#fffaff"/><stop offset="1" stop-color="#fdeef8"/></radialGradient>
</defs>
<ellipse cx="45" cy="107" rx="14" ry="8" fill="url(#fd)"/>
<ellipse cx="75" cy="107" rx="14" ry="8" fill="url(#fd)"/>
<ellipse cx="25" cy="45" rx="7" ry="9" fill="url(#fd)"/>
<ellipse cx="95" cy="45" rx="7" ry="9" fill="url(#fd)"/>
<ellipse cx="20" cy="80" rx="8" ry="11" fill="url(#f)"/>
<ellipse cx="100" cy="80" rx="8" ry="11" fill="url(#f)"/>
<path d="M60 15c26 0 42 19 42 45 0 27-17 47-42 47S18 87 18 60c0-26 16-45 42-45Z" fill="url(#f)"/>
<ellipse cx="60" cy="77" rx="25" ry="25" fill="url(#fr)"/>
<ellipse cx="39" cy="64" rx="6.5" ry="4.2" fill="#ff8fbf" opacity="0.55"/>
<ellipse cx="81" cy="64" rx="6.5" ry="4.2" fill="#ff8fbf" opacity="0.55"/>
<ellipse cx="47" cy="52" rx="6.2" ry="8" fill="#3c2b54"/>
<ellipse cx="73" cy="52" rx="6.2" ry="8" fill="#3c2b54"/>
<circle cx="49.3" cy="49.3" r="2.1" fill="#fff"/>
<circle cx="75.3" cy="49.3" r="2.1" fill="#fff"/>
<path d="M60 58c2 0 3 1.4 3 2.8 0 1.6-1.6 2.6-3 3.6-1.4-1-3-2-3-3.6 0-1.4 1-2.8 3-2.8Z" fill="#b06a93"/>
<path d="M53 66c3 5 11 5 14 0" stroke="#b06a93" stroke-width="2.6" stroke-linecap="round" fill="none"/>
</svg>`;

const PIP_URI = `data:image/svg+xml;utf8,${encodeURIComponent(PIP_SVG)}`;

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background:
            "linear-gradient(135deg, #fff6fc 0%, #f4ebff 52%, #e9f7ff 100%)",
        }}
      >
        <img src={PIP_URI} width={250} height={250} alt="" />
        <div
          style={{
            display: "flex",
            fontSize: 94,
            fontWeight: 800,
            color: "#362946",
            marginTop: 14,
            letterSpacing: "-2px",
          }}
        >
          ShaSwap
        </div>
        <div style={{ display: "flex", fontSize: 38, color: "#7a6796", marginTop: 4 }}>
          A cozy batch swap on Cardano
        </div>
      </div>
    ),
    size,
  );
}
