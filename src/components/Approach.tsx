import { DeckBtn, DeckLed } from "@/components/deck/DeckPrimitives";

const steps = [
  {
    index: "01",
    title: "Pick a spot",
    body: "Give IRSA a coordinate. It returns every SPHEREx visit that covers it, in time order.",
  },
  {
    index: "02",
    title: "Blink the visits",
    body: "Play the frames. Fixed stars hold. A mover walks.",
  },
  {
    index: "03",
    title: "Find what moves",
    body: "Compare visits, mark walkers, and chase anything new in the field.",
  },
];

export default function Approach() {
  return (
    <section className="section deck-section" id="approach">
      <div className="container">
        <div className="deck-approach">
          <header className="deck-head">
            <div className="deck-head-meta">
              <DeckLed tone="green" />
              <p className="kicker">The tool</p>
            </div>
            <h2>Coordinate → blink.</h2>
            <p className="section-lead">
              Small on purpose: pick a place, load the visits, watch what moves.
            </p>
            <p className="deck-actions">
              <DeckBtn href="/tool">Open the tool</DeckBtn>
            </p>
          </header>

          <ol className="deck-flow">
            {steps.map((step) => (
              <li className="deck-flow-step" key={step.index}>
                <span className="deck-flow-index" aria-hidden="true">
                  {step.index}
                </span>
                <div className="deck-flow-copy">
                  <h3>{step.title}</h3>
                  <p>{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
