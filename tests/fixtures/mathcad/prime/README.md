# Mathcad-Prime-Referenzdateien

Die `.mcdx`-Dateien in diesem Ordner stammen aus dem Projekt
[ChristianCruger/mcad2py](https://github.com/ChristianCruger/mcad2py) (Ordner `references/`,
Commit `778f420`) und stehen unter der MIT-Lizenz (siehe `LICENSE-mcad2py`).

Sie enthalten die von Mathcad Prime berechneten Ergebnisse (`mathcad/result.xml`).
Der Test `tests/import.verify.test.ts` importiert jede Datei, rechnet sie mit FormelWerk
neu und vergleicht jedes Ergebnis mit dem von Mathcad gespeicherten Wert.
