import Script from "next/script"

export default function OutlookAddinCommandsPage() {
  return (
    <html>
      <body>
        <Script
          src="https://appsforoffice.microsoft.com/lib/1/hosted/office.js"
          strategy="beforeInteractive"
        />
      </body>
    </html>
  )
}
