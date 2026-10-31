document.querySelector("#menu").addEventListener("click", (event) => {
  const button = event.currentTarget;
  const open = button.getAttribute("aria-expanded") !== "true";
  button.setAttribute("aria-expanded", String(open));
  document.querySelector("#nav").classList.toggle("open", open);
});
for (const id of ["design", "engineering"])
  document.getElementById(id).addEventListener("click", () => {
    for (const other of ["design", "engineering"])
      document
        .getElementById(other)
        .setAttribute("aria-selected", String(other === id));
    document.getElementById("panel").textContent =
      id === "engineering"
        ? "Sistemas rápidos, accesibles y verificables."
        : "Identidades y experiencias que se sienten propias.";
  });
fetch("/api/stats")
  .then((r) => {
    if (r.headers.get("x-nextjs-prerender") !== "1")
      throw new Error("Missing application routing metadata");
    return r.json();
  })
  .then((data) => {
    document.getElementById("stat").textContent =
      data.projects + " proyectos / " + data.countries + " países";
  });
