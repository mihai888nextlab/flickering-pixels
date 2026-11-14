import Approach from "@/components/Approach";
import BlinkStage from "@/components/BlinkStage";
import Challenge from "@/components/Challenge";
import Closing from "@/components/Closing";
import Footer from "@/components/Footer";
import GalaxyField from "@/components/GalaxyField";
import Header from "@/components/Header";
import Hero from "@/components/Hero";
import Targets from "@/components/Targets";

export default function Home() {
  return (
    <>
      <Header />
      <main className="site-main">
        <Hero />
        <div className="site-deck">
          <GalaxyField />
          <Challenge />
          <Approach />
          <BlinkStage />
          <Targets />
          <Closing />
        </div>
      </main>
      <Footer />
    </>
  );
}
