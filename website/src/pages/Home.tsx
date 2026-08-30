import Navbar from '../sections/Navbar'
import Hero from '../sections/Hero'
import Features from '../sections/Features'
import HowItWorks from '../sections/HowItWorks'
import AISection from '../sections/AISection'
import Security from '../sections/Security'
import Roadmap from '../sections/Roadmap'
import Community from '../sections/Community'
import Footer from '../sections/Footer'

export default function Home() {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 antialiased selection:bg-emerald-500/30">
      <Navbar />
      <main>
        <Hero />
        <Features />
        <HowItWorks />
        <AISection />
        <Security />
        <Roadmap />
        <Community />
      </main>
      <Footer />
    </div>
  )
}
