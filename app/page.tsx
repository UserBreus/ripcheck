import type { Metadata } from "next";
import { PreflightApp } from "./preflight-app";

export const metadata: Metadata = {
  title: "RIPcheck — Preflight para sublimación",
  description:
    "Verifica archivos PDF y AI antes de enviarlos a un RIP de sublimación.",
};

export default function Home() {
  return <PreflightApp />;
}
