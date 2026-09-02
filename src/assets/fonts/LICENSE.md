# Bundled fonts

Both families ship under the **SIL Open Font License 1.1**, which permits
bundling and redistribution inside an application.

| Family | Files | Author | Source |
|---|---|---|---|
| PT Serif | `PTSerif-{Regular,Bold,Italic,BoldItalic}.ttf` | ParaType | <https://fonts.google.com/specimen/PT+Serif> |
| Inter | `Inter-Variable.ttf`, `Inter-Italic-Variable.ttf` | Rasmus Andersson | <https://fonts.google.com/specimen/Inter> |

They are bundled rather than assumed installed because neither ships with a
stock macOS or Linux install. Relying on the system copy meant the app silently
fell back to Georgia and the platform UI sans outside Windows — readable, but
not the typeface the interface was designed around.

The OFL requires the license to travel with the fonts; the full text is at
<https://openfontlicense.org>.
