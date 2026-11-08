; Adds the app to Explorer's "Open with" list for .html / .htm, PDF, Markdown and picture files. Unlike
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
  WriteRegNone SHELL_CONTEXT "Software\Classes\.pdf\OpenWithProgids" "${FOLIO_PROGID}"
  WriteRegNone SHELL_CONTEXT "Software\Classes\.md\OpenWithProgids" "${FOLIO_PROGID}"
  WriteRegNone SHELL_CONTEXT "Software\Classes\.markdown\OpenWithProgids" "${FOLIO_PROGID}"
  WriteRegNone SHELL_CONTEXT "Software\Classes\.png\OpenWithProgids" "${FOLIO_PROGID}"
  WriteRegNone SHELL_CONTEXT "Software\Classes\.jpg\OpenWithProgids" "${FOLIO_PROGID}"
  WriteRegNone SHELL_CONTEXT "Software\Classes\.jpeg\OpenWithProgids" "${FOLIO_PROGID}"
  WriteRegNone SHELL_CONTEXT "Software\Classes\.gif\OpenWithProgids" "${FOLIO_PROGID}"
  WriteRegNone SHELL_CONTEXT "Software\Classes\.webp\OpenWithProgids" "${FOLIO_PROGID}"
  WriteRegNone SHELL_CONTEXT "Software\Classes\.avif\OpenWithProgids" "${FOLIO_PROGID}"
  WriteRegNone SHELL_CONTEXT "Software\Classes\.bmp\OpenWithProgids" "${FOLIO_PROGID}"
  WriteRegNone SHELL_CONTEXT "Software\Classes\.svg\OpenWithProgids" "${FOLIO_PROGID}"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".html" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".htm" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".pdf" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".md" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".markdown" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".png" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".jpg" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".jpeg" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".gif" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".webp" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".avif" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".bmp" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".svg" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\shell\open\command" "" '"$appExe" "%1"'
  System::Call "shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)"
!macroend

!macro customUnInstall
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.html\OpenWithProgids" "${FOLIO_PROGID}"
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.htm\OpenWithProgids" "${FOLIO_PROGID}"
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.pdf\OpenWithProgids" "${FOLIO_PROGID}"
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.md\OpenWithProgids" "${FOLIO_PROGID}"
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.markdown\OpenWithProgids" "${FOLIO_PROGID}"
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.png\OpenWithProgids" "${FOLIO_PROGID}"
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.jpg\OpenWithProgids" "${FOLIO_PROGID}"
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.jpeg\OpenWithProgids" "${FOLIO_PROGID}"
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.gif\OpenWithProgids" "${FOLIO_PROGID}"
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.webp\OpenWithProgids" "${FOLIO_PROGID}"
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.avif\OpenWithProgids" "${FOLIO_PROGID}"
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.bmp\OpenWithProgids" "${FOLIO_PROGID}"
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.svg\OpenWithProgids" "${FOLIO_PROGID}"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\${FOLIO_PROGID}"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"
!macroend
