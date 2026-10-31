# Falcon 9 — symulator startu i lotu 3D

Symulator startu rakiety Falcon 9 w przeglądarce: od zapłonu na stanowisku startowym,
przez Max-Q, MECO, separację stopni i zrzut owiewki, aż do wejścia na niską orbitę okołoziemską.

Zbudowany w **Vite + TypeScript + Three.js** — bez zewnętrznych modeli i tekstur,
wszystko generowane proceduralnie.

## Uruchomienie

```bash
npm install
npm run dev       # serwer deweloperski (http://localhost:5173)
npm run build     # typecheck (tsc) + build produkcyjny do dist/
npm run preview   # podgląd zbudowanej wersji
```

## Deploy

Każdy push na `main` buduje projekt i publikuje go na GitHub Pages
(workflow `.github/workflows/deploy.yml`): https://palovlad.github.io/studious-doodle/

## Sterowanie

| Akcja | Przycisk / klawisz |
|---|---|
| Start | **START** / `Spacja` |
| Przerwanie lotu | **ABORT** / `A` |
| Reset | **RESET** / `R` |
| Przepustnica (40–100%) | suwak / `↑` `↓` |
| Kamera: pościg, pokładowa, naziemna, panorama, booster, Ziemia | przyciski / `1`–`6` |
| Dźwięk: wyciszenie / głośność | 🔊 i suwak / `M` |
| Rezerwa paliwa I stopnia na powrót (0–15%, do MECO) | suwak „Rezerwa paliwa I st.” |
| Planowany ciąg landing burn (40–100%) | suwak „Ciąg lądowania” |
| Przyspieszenie czasu | lista „Czas” (×1 … ×50) |
| Obrót / zoom (kamera pościgowa) | mysz / dotyk |

## Struktura

```
src/
├── main.ts            # renderer, pętla, kamery, spięcie modułów
├── sim/physics.ts     # model fizyczny lotu i odzysku I stopnia
├── gfx/rocket.ts      # proceduralny model Falcon 9
├── gfx/particles.ts   # ogień i spaliny (systemy cząsteczek)
├── gfx/droneship.ts   # barka lądowiskowa na oceanie
├── gfx/earth.ts       # proceduralna Ziemia (shader GPU) i warstwa chmur
├── gfx/scene.ts       # stanowisko startowe, światło, niebo, atmosfera
├── audio/sfx.ts       # proceduralne dźwięki (Web Audio API)
└── ui/hud.ts (+ .css) # telemetria i panel sterowania
```

### Fizyka (`src/sim/physics.ts`)
- Lot w płaszczyźnie trajektorii nad kulistą Ziemią (układ związany ze środkiem Ziemi).
- Zmienna masa: spalanie paliwa (przepływ masowy z ciągu i Isp), zrzut I stopnia i owiewki.
- Ciąg Merlin 1D zależny od ciśnienia otoczenia (Isp 282 s → 311 s), MVac 981 kN / 348 s.
- Grawitacja `μ/r²` malejąca z wysokością.
- Opór: atmosfera wykładnicza, Cd zależne od liczby Macha (szczyt transoniczny), prędkość dźwięku wg atmosfery wzorcowej.
- Trajektoria **gravity turn**: pionowe wznoszenie → pitch-over przy ~55 m/s → oś podąża za wektorem prędkości.
- II stopień: pętla naprowadzania na orbitę ~200 km, SECO po osiągnięciu perygeum.
- Telemetria: wysokość, prędkość, Mach, ciśnienie dynamiczne (Max-Q), przeciążenie, apogeum/perygeum.

Z domyślnymi parametrami (12 t ładunku) lot kończy się na orbicie ok. 185 × 225 km po ~7,5 min.

### Odzysk I stopnia i lądowanie na barce
Po separacji I stopień leci osobno:
1. **Manewr obrotu**: obraca się silnikami do przodu, czyli przeciwnie do kierunku lotu.
2. **Lot balistyczny**: grid fins się rozkładają.
3. **Entry burn**: 3 silniki hamują od ~70 km przed wejściem w gęste warstwy atmosfery.
   Nadwyżkę paliwa ponad budżet lądowania entry burn zużywa na dodatkowe hamowanie.
4. **Opadanie**: hamowanie oporem powietrza.
5. **Landing burn** („hoverslam”): komputer symuluje w przód hamowanie i odpala silnik
   w chwili, gdy przewidywany punkt zatrzymania schodzi do pokładu.
   Ciężki stopień hamuje na 3 silnikach, a potem przechodzi na 1.
6. **Przyziemienie** na barce, która czeka w przewidzianym miejscu na oceanie.

Wynik zależy od ustawień:
- **Rezerwa paliwa**:
  - za mała → rozpad w atmosferze (brak entry burn) albo brak paliwa na lądowanie,
  - za duża → II stopniowi brakuje paliwa i ładunek nie wchodzi na orbitę.
- **Ciąg lądowania**:
  - wyższy → późniejszy zapłon i mniejsze straty grawitacyjne (oszczędność paliwa), ale mniejszy zapas na korekty; przy 100% przyziemienie jest za twarde,
  - zbyt niski → minimalny ciąg silnika przewyższa ciężar, stopień zawisa nad pokładem, silnik się wyłącza i stopień spada.

Lądowanie jest udane, gdy prędkość pionowa ≤ 4 m/s, pozioma ≤ 3 m/s, a stopień trafił w pokład.
W każdym innym przypadku I stopień wybucha. Przy domyślnych ustawieniach (8%, 75%)
stopień ląduje z ~2 t paliwa.

### Grafika
- Model w skali 1:1: 9 dysz Merlin (Octaweb), kadłub z napisem, czarny interstage,
  4 kratownicowe stery (grid fins), 4 nogi do lądowania, II stopień z dyszą MVac,
  owiewka z dwóch połówek i ładunek.
- Po separacji I stopień wykonuje obrót, rozkłada grid fins i nogi, a płomień entry/landing burn pochodzi z właściwych silników (3 lub 1).
- Autonomiczna barka lądowiskowa: pokład z oznaczeniem celu, ściany osłonowe i pędniki. Płomień przy lądowaniu rozpływa się po pokładzie.
- Cząsteczki: płomień (rozszerza się w próżni), dym zostający w powietrzu, odbicie płomienia od stołu startowego i chmury pary.
- Niebo: shader gradientu zależny od wysokości — błękit przechodzi w czerń kosmosu, pojawiają się gwiazdy i poświata atmosfery na horyzoncie.
- Ziemia liczona w shaderze GPU z szumu 3D:
  - kontynenty i biomy (lasy, pustynie, tundra, lód),
  - głębia oceanu i odblask słońca na wodzie,
  - rzeźba terenu, łuna terminatora i światła miast po nocnej stronie,
  - warstwa chmur z cieniami.
  Detal dopasowuje się do rozdzielczości ekranu, a linie brzegowe są wygładzone.
- Kamera „Ziemia”: widok na horyzont i krzywiznę Ziemi zza II stopnia.
- Logarytmiczny bufor głębi pozwala renderować jednocześnie stanowisko (metry) i całą Ziemię (tysiące km).

### Dźwięk
Wszystkie dźwięki są syntezowane w przeglądarce (Web Audio API, bez plików).
Dźwięk włącza się po pierwszym kliknięciu albo naciśnięciu klawisza.
- **Ryk silników**:
  - głośność rośnie z ciągiem i liczbą silników,
  - zależy od gęstości powietrza: w próżni z kamer zewnętrznych jest cicho, a w kamerze pokładowej słychać stłumiony rumor konstrukcji,
  - cichnie z odległością kamery, a w kamerze naziemnej dociera z opóźnieniem jak prawdziwy dźwięk (343 m/s),
  - powracający I stopień ma osobny dźwięk.
- **Wybuch**: przy zderzeniu z ziemią i nieudanym lądowaniu (huk, niski „thump”, pogłos).
- **Drobne efekty**: syk pneumatyki przy separacji i zrzucie owiewki, „klik” zapłonu silników.

## Licencja

GPL-3.0 — patrz [LICENSE](LICENSE).
