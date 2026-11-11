let disarm;
let pending;

export function disarmRuleLink() {
  return disarm;
}

export function loadDisarmRule() {
  if (pending) return pending;
  const pack = game.packs.get("swade-core-rules.swade-rules");
  if (!pack) return Promise.resolve();
  pending = findDisarm(pack).then(link => { disarm = link; }).catch(error => {
    console.warn("Better Called Shots | Could not load the Disarm rule", error);
  });
  return pending;
}

async function findDisarm(pack) {
  const index = await pack.getIndex();
  const chapters = [...index].sort((a, b) => Number(/combat|rules/i.test(b.name)) - Number(/combat|rules/i.test(a.name)));
  for (const chapter of chapters) {
    const journal = await pack.getDocument(chapter._id);
    for (const page of journal?.pages ?? []) {
      if (/^disarm(?:ed)?$/i.test(page.name.trim())) return `@UUID[${page.uuid}]{Disarmed}`;
      const content = document.createElement("template");
      content.innerHTML = page.text?.content ?? "";
      const heading = [...content.content.querySelectorAll("h1,h2,h3,h4,h5,h6")].find(node => /^disarm$/i.test(node.textContent.trim()));
      if (heading) return `@UUID[${page.uuid}#${heading.id || "disarm"}]{Disarmed}`;
    }
  }
}
