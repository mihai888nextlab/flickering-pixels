import {
  DeckChassis,
  DeckLcd,
  DeckLed,
} from "@/components/deck/DeckPrimitives";

const stats = [
  { value: "102", label: "IR bands per visit" },
  { value: "6 mo", label: "between all-sky maps" },
  { value: "1B+", label: "objects in the survey" },
];

export default function Challenge() {
  return (
    <section className="section after-flight deck-section" id="challenge">
      <div className="container">
        <header className="deck-head">
          <div className="deck-head-meta">
            <DeckLed tone="cyan" pulse />
            <p className="kicker">The brief</p>
          </div>
          <h2>A billion objects. Nobody can watch them all.</h2>
          <p className="section-lead">
            SPHEREx is mapping the near-infrared sky. The interesting sources are
            the ones that move — and they need a public way to look.
          </p>
        </header>

        <DeckChassis label="Mission scale">
          <div className="deck-lcd-row" aria-label="Mission scale">
            {stats.map((stat) => (
              <DeckLcd key={stat.label} value={stat.value} caption={stat.label} />
            ))}
          </div>
        </DeckChassis>
      </div>
    </section>
  );
}
