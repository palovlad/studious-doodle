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
| Kamera: pościg, pokładowa, naziemna, panorama, booster | przyciski / `1`–`5` |
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
├── gfx/scene.ts       # Ziemia, stanowisko startowe, światło, niebo
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
- Logarytmiczny bufor głębi pozwala renderować jednocześnie stanowisko (metry) i całą Ziemię (tysiące km).

## Licencja

GPL-3.0 — patrz [LICENSE](LICENSE).
