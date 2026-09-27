; Adds the app to Explorer's "Open with" list for .html / .htm files. Unlike
; electron-builder's fileAssociations, this leaves the user's default program
; (usually a browser) unchanged, like the "Alternate" role on macOS.
; Keep this file ASCII: makensis reads includes in the system code page.

!define FOLIO_PROGID "Folio.HTML"

!macro customInstall
  WriteRegStr SHELL_CONTEXT "Software\Classes\${FOLIO_PROGID}" "" "HTML"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${FOLIO_PROGID}\DefaultIcon" "" "$appExe,0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${FOLIO_PROGID}\shell\open\command" "" '"$appExe" "%1"'
  WriteRegNone SHELL_CONTEXT "Software\Classes\.html\OpenWithProgids" "${FOLIO_PROGID}"
  WriteRegNone SHELL_CONTEXT "Software\Classes\.htm\OpenWithProgids" "${FOLIO_PROGID}"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".html" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".htm" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\shell\open\command" "" '"$appExe" "%1"'
  System::Call "shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)"
!macroend

!macro customUnInstall
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.html\OpenWithProgids" "${FOLIO_PROGID}"
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.htm\OpenWithProgids" "${FOLIO_PROGID}"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\${FOLIO_PROGID}"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"
!macroend
