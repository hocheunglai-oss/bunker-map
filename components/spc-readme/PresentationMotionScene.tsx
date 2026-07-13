type PresentationMotionSceneProps = {
  scene: string
  title: string
  keyPoints: string[]
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

export function PresentationMotionScene({ scene, title, keyPoints, compact = false }: PresentationMotionSceneProps) {
  let content: React.ReactNode
  if (scene === "daily-pressure") content = <DailyPressureScene title={title} />
  else if (scene === "varied-formats") content = <VariedFormatsScene title={title} />
  else if (scene === "whatsapp-load") content = <WhatsappLoadScene title={title} />
  else if (scene === "prompt-structure") content = <PromptStructureScene title={title} />
  else if (scene === "live-prompt") content = <LivePromptScene title={title} />
  else if (scene === "ai-response") content = <AiResponseScene title={title} />
  else if (scene === "human-review") content = <HumanReviewScene title={title} />
  else content = <TakeawayScene title={title} keyPoints={keyPoints} />

  return (
    <div className={`spc-readme-motion-scene${compact ? " is-compact" : ""}`} role="img" aria-label={title}>
      {content}
      <div className="spc-readme-motion-brand"><span>FRATELLI COSULICH</span><strong>SINGAPORE PURCHASING CENTER</strong></div>
    </div>
  )
}
