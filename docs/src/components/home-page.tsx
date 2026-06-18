import { HomeLayout } from "fumadocs-ui/layouts/home";
import { baseOptions } from "@/lib/layout.shared";
import { HomeFeatures } from "./home-features";
import { HomeHero } from "./home-hero";
import { HomePrivacy } from "./home-privacy";
import { HomeScreenshot } from "./home-screenshot";
import { HomeShowcase } from "./home-showcase";

export function HomePage() {
  return (
    <HomeLayout {...baseOptions()}>
      <div className="flex flex-1 flex-col items-center overflow-hidden">
        <HomeHero />
        <HomeScreenshot />
        <HomeShowcase />
        <HomePrivacy />
        <HomeFeatures />
      </div>
    </HomeLayout>
  );
}
