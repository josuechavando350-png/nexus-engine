import { Chatbots } from "@/components/sections/Chatbots";
import { Core } from "@/components/sections/Core";
import { Frase } from "@/components/sections/Frase";
import { Hero } from "@/components/sections/Hero";
import { Motores } from "@/components/sections/Motores";
import { Productos } from "@/components/sections/Productos";

export default function HomePage() {
  return (
    <>
      <Hero />
      <Motores />
      <Frase />
      <Productos />
      <Chatbots />
      <Core />
    </>
  );
}
