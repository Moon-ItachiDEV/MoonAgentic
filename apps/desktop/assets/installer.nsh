; Textes de l'installateur Windows (NSIS), lus par electron-builder dans assets/.
; Les autres pages gardent la traduction française de NSIS.

!ifndef BUILD_UNINSTALLER
  !macro customWelcomePage
    !define MUI_WELCOMEPAGE_TITLE "Bienvenue dans l'installation de MoonAgentic"
    !define MUI_WELCOMEPAGE_TEXT "MoonAgentic fait travailler tes agents de code (Claude Code, Codex, Antigravity…) depuis une seule fenêtre, et continue en arrière-plan quand tu la fermes.$\r$\n$\r$\nTon historique et tes réglages sont gardés : si tu as déjà lancé MoonAgentic, tu retrouves tout.$\r$\n$\r$\nClique sur Suivant pour continuer."
    !insertmacro MUI_PAGE_WELCOME
  !macroend

  !define MUI_FINISHPAGE_TITLE "MoonAgentic est installé"
  !define MUI_FINISHPAGE_TEXT "Tu le retrouves dans le menu Démarrer et sur le Bureau.$\r$\n$\r$\nSon icône près de l'horloge rouvre la fenêtre. Pour un mini-PC allumé jour et nuit, coche « Lancer avec Windows » dans son menu."
  !define MUI_FINISHPAGE_RUN_TEXT "Lancer MoonAgentic"
!endif
