import type { SpcPresentationVisualText } from "@/lib/spcPresentation"

type PresentationMotionSceneProps = {
  scene: string
  title: string
  keyPoints: string[]
  visualCopy?: SpcPresentationVisualText[]
  compact?: boolean
}

const enquiryRows = [
  ["09:02", "MACAU STAR", "VLSFO / LSMGO"],
  ["09:04", "PACIFIC HORNBILL", "LSMGO"],
  ["09:07", "OCEAN LEADER", "HSFO / VLSFO"],
  ["09:11", "TAISEI MARU NO.15", "VLSFO"],
] as const

const promptLines = [
  "We operate a bunker purchasing center.",
  "Enquiries arrive in many different formats.",
  "Supplier traders manage many WhatsApp chats.",
  "A human must verify every message before sending.",
  "Suggest one small, practical first improvement.",
] as const

function SceneHeader({ label }: { label: string; title: string }) {
  return (
    <div className="spc-readme-scene-heading">
      <span>{label}</span>
    </div>
  )
}

function ChapterIntroScene() {
  return (
    <div className="spc-readme-motion-layout is-intro">
      <div className="spc-readme-intro-kicker">INTERMEDIATE SESSION</div>
      <div className="spc-readme-intro-title">
        <span>INCORPORATE</span>
        <strong>AI INTO TRADING</strong>
        <p>Start with the operating problem. Keep the trader in control.</p>
      </div>
      <div className="spc-readme-intro-flow" aria-label="Session approach">
        {[
          ["01", "TRADING PRESSURE"],
          ["02", "AI THINKING PARTNER"],
          ["03", "HUMAN JUDGEMENT"],
        ].map(([number, label], index) => (
          <div style={{ animationDelay: `${index * 1.25}s` }} key={label}>
            <span>{number}</span>
            <strong>{label}</strong>
          </div>
        ))}
      </div>
    </div>
  )
}

function DailyPressureScene({ title }: { title: string }) {
  return (
    <div className="spc-readme-motion-layout is-pressure">
      <SceneHeader label="SPC WORKFLOW" title={title} />
      <div className="spc-readme-motion-queue">
        <div className="spc-readme-motion-window-bar">
          <span>INCOMING ENQUIRIES</span>
          <strong>LIVE</strong>
        </div>
        {enquiryRows.map((row, index) => (
          <div className="spc-readme-motion-enquiry" style={{ animationDelay: `${index * 1.8}s` }} key={row[1]}>
            <span>{row[0]}</span>
            <strong>{row[1]}</strong>
            <small>{row[2]}</small>
          </div>
        ))}
      </div>
      <div className="spc-readme-motion-counter">
        <span>DAILY QUEUE</span>
        <strong>28</strong>
        <small>REVIEW • EXTRACT • PREPARE</small>
      </div>
    </div>
  )
}

function VariedFormatsScene({ title }: { title: string }) {
  return (
    <div className="spc-readme-motion-layout is-formats">
      <SceneHeader label="RAW ENQUIRIES" title={title} />
      <div className="spc-readme-raw-stack" aria-label="Examples of differently formatted enquiries">
        <p style={{ animationDelay: "0s" }}>MV SHAN REN ETA 11-13 JAN<br />VLSFO 110 / LSMGO 55</p>
        <p style={{ animationDelay: "1.8s" }}>YASA SAPPHIRE / 8-12 OCT<br />VLSFO 180CST MAX 700-800 MTS</p>
        <p style={{ animationDelay: "3.6s" }}>A KEIGA 9385453<br />3 OCT VLSFO ABT 260MT</p>
      </div>
      <div className="spc-readme-format-arrow" aria-hidden="true">→</div>
      <div className="spc-readme-format-output">
        <span>STANDARD DRAFT</span>
        <strong>yasa sapphire / 9949182 / 8 - 12 oct / vlsfo 180CST MAX 700-800mts</strong>
        <small>TRADER CHECK REQUIRED</small>
      </div>
    </div>
  )
}

function WhatsappLoadScene({ title }: { title: string }) {
  return (
    <div className="spc-readme-motion-layout is-whatsapp">
      <SceneHeader label="SUPPLIER COMMUNICATION" title={title} />
      <div className="spc-readme-chat-grid">
        {["BP MARINE", "EQUATORIAL", "SFI ENERGY", "CHEVRON"].map((supplier, index) => (
          <div className="spc-readme-chat-window" style={{ animationDelay: `${index * 1.3}s` }} key={supplier}>
            <div><strong>{supplier}</strong><span>{index + 1}</span></div>
            <p className="is-incoming">Checking...</p>
            <p className="is-outgoing">Please quote best.</p>
            <p className="is-incoming">Need IMO?</p>
          </div>
        ))}
      </div>
      <div className="spc-readme-context-strip">
        <span>4 ENQUIRIES</span><span>16 ACTIVE CHATS</span><span>ONE TRADER</span>
      </div>
    </div>
  )
}

function PromptStructureScene({ title }: { title: string }) {
  const steps = ["CONTEXT", "FRICTION", "BOUNDARIES", "ONE NEXT STEP"]
  return (
    <div className="spc-readme-motion-layout is-method">
      <SceneHeader label="PROMPT METHOD" title={title} />
      <div className="spc-readme-method-track">
        {steps.map((step, index) => (
          <div style={{ animationDelay: `${index * 1.4}s` }} key={step}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <strong>{step}</strong>
          </div>
        ))}
      </div>
      <p>Make the problem specific before asking AI to solve it.</p>
    </div>
  )
}

function LivePromptScene({ title }: { title: string }) {
  return (
    <div className="spc-readme-motion-layout is-live-prompt">
      <SceneHeader label="ACTUAL DEMONSTRATION" title={title} />
      <div className="spc-readme-browser-frame">
        <div className="spc-readme-browser-toolbar"><i /><i /><i /><span>chatgpt.com</span></div>
        <div className="spc-readme-prompt-composer">
          {promptLines.map((line, index) => (
            <p style={{ animationDelay: `${index * 2.1}s` }} key={line}>{line}</p>
          ))}
          <span className="spc-readme-typing-cursor" aria-hidden="true" />
        </div>
      </div>
    </div>
  )
}

function AiResponseScene({ title }: { title: string }) {
  return (
    <div className="spc-readme-motion-layout is-response">
      <SceneHeader label="AI RESPONSE" title={title} />
      <div className="spc-readme-response-copy">
        <p>Start by standardising every enquiry <strong>before</strong> a human sends it.</p>
        <ol>
          <li>Read the raw message.</li>
          <li>Extract the commercial details.</li>
          <li>Prepare one consistent draft.</li>
          <li>Require trader verification.</li>
        </ol>
      </div>
      <div className="spc-readme-response-boundary">NO AUTOMATIC SENDING</div>
    </div>
  )
}

function HumanReviewScene({ title }: { title: string }) {
  const stages = ["RAW ENQUIRY", "AI DRAFT", "TRADER CHECK", "SEND"]
  return (
    <div className="spc-readme-motion-layout is-human-review">
      <SceneHeader label="CONTROLLED WORKFLOW" title={title} />
      <div className="spc-readme-workflow-line">
        {stages.map((stage, index) => (
          <div className={index === 2 ? "is-human" : ""} style={{ animationDelay: `${index * 1.5}s` }} key={stage}>
            <span>{index === 2 ? "HUMAN" : index === 1 ? "AI" : String(index + 1).padStart(2, "0")}</span>
            <strong>{stage}</strong>
          </div>
        ))}
      </div>
    </div>
  )
}

function TakeawayScene({ title, keyPoints }: { title: string; keyPoints: string[] }) {
  return (
    <div className="spc-readme-motion-layout is-takeaway">
      <SceneHeader label="CHAPTER 1" title={title} />
      <div className="spc-readme-takeaway-list">
        {(keyPoints.length ? keyPoints : ["START SMALL", "TEST", "VERIFY"]).slice(0, 3).map((point, index) => (
          <div style={{ animationDelay: `${index * 1.6}s` }} key={point}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <strong>{point}</strong>
          </div>
        ))}
      </div>
    </div>
  )
}

function visualText(
  visualCopy: SpcPresentationVisualText[],
  id: string,
  fallback: string,
) {
  return visualCopy.find((item) => item.id === id)?.text || fallback
}

function WarmUpEnquiryScene({
  title,
  visualCopy,
}: {
  title: string
  visualCopy: SpcPresentationVisualText[]
}) {
  const vessel = visualText(visualCopy, "vessel", "Raven Arrow")
  const details = [
    ["VESSEL", vessel],
    ["IMO", visualText(visualCopy, "imo", "9574858")],
    ["PORT", visualText(visualCopy, "port", "SGP")],
    ["AGENT", visualText(visualCopy, "agent", "TBA")],
    ["ETA", visualText(visualCopy, "eta", "21ST - 23RD SEPTEMBER 2026")],
  ] as const
  const notes = [
    visualText(
      visualCopy,
      "operational-note-1",
      "IF UNABLE TO OFFER FOR A DELIVERY 1 JANUARY, PLS OFFER BASED ON YR EARLIEST DELIVERY DATE.",
    ),
    visualText(
      visualCopy,
      "operational-note-2",
      "OFFICIAL SAMPLES FOR DISPUTE RESOLUTION ARE TO BE TAKEN AT THE RECEIVING VESSELS MANIFOLD.",
    ),
    visualText(
      visualCopy,
      "operational-note-3",
      "Buyer will appoint Lintec/Intertek to perform a Bunker Quantity Survey on this delivery.",
    ),
    visualText(
      visualCopy,
      "operational-note-4",
      "The Bunker delivery is NOT to commence until the Surveyor is present and has performed pre delivery checks.",
    ),
    visualText(
      visualCopy,
      "operational-note-5",
      "Note: In ports where procedures permit the vessel must receive a Certificate of Quality (COQ) for each supply of VLSFO.",
    ),
  ]

  return (
    <div className="spc-readme-motion-layout is-warm-up">
      <header className="spc-readme-warm-up-heading">
        <span>LIVE DEMONSTRATION</span>
        <strong>{title || "WARM UP ACTIVITY"}</strong>
      </header>
      <article className="spc-readme-warm-up-document" aria-label={`${vessel} bunker enquiry`}>
        <div className="spc-readme-warm-up-details">
          <dl>
            {details.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <span>BUNKER ENQUIRY</span>
        </div>
        <section className="spc-readme-warm-up-notes">
          <h3>OPERATIONAL NOTES</h3>
          {notes.map((note, index) => (
            <p className={index < 2 ? "is-priority" : ""} key={note}>{note}</p>
          ))}
        </section>
        <table className="spc-readme-warm-up-grades">
          <caption>GRADES AND QUANTITIES</caption>
          <thead><tr><th>SPEC</th><th>QUANTITY</th></tr></thead>
          <tbody>
            <tr>
              <td>{visualText(visualCopy, "spec", "ISO 8217 2017 VLSFO RMG 380 0.50%")}</td>
              <td>{visualText(visualCopy, "quantity", "300 - 400 METRIC TONS")}</td>
            </tr>
          </tbody>
        </table>
      </article>
    </div>
  )
}

export function PresentationMotionScene({
  scene,
  title,
  keyPoints,
  visualCopy = [],
  compact = false,
}: PresentationMotionSceneProps) {
  let content: React.ReactNode
  if (scene === "chapter-intro") content = <ChapterIntroScene />
  else if (scene === "daily-pressure") content = <DailyPressureScene title={title} />
  else if (scene === "varied-formats") content = <VariedFormatsScene title={title} />
  else if (scene === "whatsapp-load") content = <WhatsappLoadScene title={title} />
  else if (scene === "prompt-structure") content = <PromptStructureScene title={title} />
  else if (scene === "live-prompt") content = <LivePromptScene title={title} />
  else if (scene === "ai-response") content = <AiResponseScene title={title} />
  else if (scene === "human-review") content = <HumanReviewScene title={title} />
  else if (scene === "warm-up-enquiry") content = <WarmUpEnquiryScene title={title} visualCopy={visualCopy} />
  else content = <TakeawayScene title={title} keyPoints={keyPoints} />

  return (
    <div
      className={`spc-readme-motion-scene${compact ? " is-compact" : ""}`}
      role={scene === "warm-up-enquiry" ? "region" : "img"}
      aria-label={title}
    >
      {content}
      <div className="spc-readme-motion-brand"><span>FRATELLI COSULICH</span><strong>SINGAPORE PURCHASING CENTER</strong></div>
    </div>
  )
}
