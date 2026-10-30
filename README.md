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
| Kamera: pościg, pokładowa, naziemna, panorama | przyciski / `1`–`4` |
| Przyspieszenie czasu | lista „Czas” (×1 … ×50) |
| Obrót / zoom (kamera pościgowa) | mysz / dotyk |

## Struktura

```
src/
├── main.ts            # renderer, pętla, kamery, spięcie modułów
├── sim/physics.ts     # model fizyczny lotu
├── gfx/rocket.ts      # proceduralny model Falcon 9
├── gfx/particles.ts   # ogień i spaliny (systemy cząsteczek)
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

### Grafika
- Model w skali 1:1: 9 dysz Merlin (Octaweb), kadłub z napisem, czarny interstage,
  4 kratownicowe stery (grid fins), 4 nogi do lądowania, II stopień z dyszą MVac,
  owiewka z dwóch połówek i ładunek.
- Po separacji I stopień leci po własnej balistyce, wykonuje obrót, rozkłada grid fins i nogi.
- Cząsteczki: płomień (rozszerza się w próżni), dym zostający w powietrzu, odbicie płomienia od stołu startowego i chmury pary.
- Niebo: shader gradientu zależny od wysokości — błękit przechodzi w czerń kosmosu, pojawiają się gwiazdy i poświata atmosfery na horyzoncie.
- Logarytmiczny bufor głębi pozwala renderować jednocześnie stanowisko (metry) i całą Ziemię (tysiące km).

## Licencja

GPL-3.0 — patrz [LICENSE](LICENSE).
