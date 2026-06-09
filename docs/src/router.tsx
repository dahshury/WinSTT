import { createRouter } from "@tanstack/react-router";
import { getBasePath } from "@/lib/site";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  return createRouter({
    routeTree,
    basepath: getBasePath() || "/",
    defaultPreload: "intent",
    scrollRestoration: true,
  });
}
