fetch(chrome.runtime.getURL("data/meta.json"))
  .then((r) => r.json())
  .then((meta) => {
    document.getElementById("pcount").textContent = meta.problem_count;
    document.getElementById("ccount").textContent = meta.company_count;
    document.getElementById("updated").textContent = "Data compiled " + meta.generated + ".";
  })
  .catch(() => {});
