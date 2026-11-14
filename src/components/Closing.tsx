import { DeckBtn, DeckLed, DeckNameplate } from "@/components/deck/DeckPrimitives";

export default function Closing() {
  return (
    <section className="section deck-section deck-closing">
      <div className="container">
        <DeckNameplate>
          <div className="deck-nameplate-copy">
            <div className="deck-head-meta">
              <DeckLed tone="green" pulse />
              <p className="kicker">The team</p>
            </div>
            <h2>Flickering Pixels</h2>
            <p className="section-lead">
              Next step: real SPHEREx visits, open to anyone.
            </p>
          </div>
          <DeckBtn
            href="https://www.spaceappschallenge.org/2026/find-a-team/flickering-pixels/"
            external
          >
            Meet the team
          </DeckBtn>
        </DeckNameplate>
      </div>
    </section>
  );
}
