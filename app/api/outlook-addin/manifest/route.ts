import { NextResponse } from "next/server"

const ADDIN_ASSET_VERSION = "2026-06-08-recipient-map-v1"

function xmlEscape(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

function buildBaseUrl(request: Request) {
  const configured = process.env.NEXT_PUBLIC_SITE_URL
  if (configured) return configured.replace(/\/$/, "")

  const url = new URL(request.url)
  const hostname = url.hostname === "localhost" || url.hostname === "127.0.0.1" ? "localhost" : url.hostname
  const port = url.port ? `:${url.port}` : ""
  const protocol = hostname === "localhost" ? "https:" : url.protocol
  return `${protocol}//${hostname}${port}`
}

export async function GET(request: Request) {
  const baseUrl = buildBaseUrl(request)
  const taskpaneUrl = `${baseUrl}/api/outlook-addin/taskpane?v=${ADDIN_ASSET_VERSION}`
  const commandsUrl = `${baseUrl}/api/outlook-addin/commands?v=${ADDIN_ASSET_VERSION}`
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<OfficeApp xmlns="http://schemas.microsoft.com/office/appforoffice/1.1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:bt="http://schemas.microsoft.com/office/officeappbasictypes/1.0"
  xsi:type="MailApp">
  <Id>6f6b5bde-1a6b-4c82-8300-1d2d728c7c61</Id>
  <Version>1.0.4.0</Version>
  <ProviderName>Fratelli Cosulich</ProviderName>
  <DefaultLocale>en-US</DefaultLocale>
  <DisplayName DefaultValue="Fratelli Cosulich Templates"/>
  <Description DefaultValue="Insert shared company email templates from the central template library."/>
  <IconUrl DefaultValue="${xmlEscape(baseUrl)}/outlook-template-icon-32.png"/>
  <HighResolutionIconUrl DefaultValue="${xmlEscape(baseUrl)}/outlook-template-icon-80.png"/>
  <SupportUrl DefaultValue="${xmlEscape(baseUrl)}/admin/emailtemplates"/>
  <AppDomains>
    <AppDomain>${xmlEscape(baseUrl)}</AppDomain>
  </AppDomains>
  <Hosts>
    <Host Name="Mailbox"/>
  </Hosts>
  <Requirements>
    <Sets>
      <Set Name="Mailbox" MinVersion="1.3"/>
    </Sets>
  </Requirements>
  <FormSettings>
    <Form xsi:type="ItemRead">
      <DesktopSettings>
        <SourceLocation DefaultValue="${xmlEscape(taskpaneUrl)}"/>
        <RequestedHeight>450</RequestedHeight>
      </DesktopSettings>
    </Form>
    <Form xsi:type="ItemEdit">
      <DesktopSettings>
        <SourceLocation DefaultValue="${xmlEscape(taskpaneUrl)}"/>
      </DesktopSettings>
    </Form>
  </FormSettings>
  <Permissions>ReadWriteItem</Permissions>
  <Rule xsi:type="RuleCollection" Mode="Or">
    <Rule xsi:type="ItemIs" ItemType="Message" FormType="Read"/>
    <Rule xsi:type="ItemIs" ItemType="Message" FormType="Edit"/>
  </Rule>
  <DisableEntityHighlighting>false</DisableEntityHighlighting>
  <VersionOverrides xmlns="http://schemas.microsoft.com/office/mailappversionoverrides" xsi:type="VersionOverridesV1_0">
    <Requirements>
      <bt:Sets DefaultMinVersion="1.3">
        <bt:Set Name="Mailbox"/>
      </bt:Sets>
    </Requirements>
    <Hosts>
      <Host xsi:type="MailHost">
        <DesktopFormFactor>
          <FunctionFile resid="Commands.Url"/>
          <ExtensionPoint xsi:type="MessageComposeCommandSurface">
            <OfficeTab id="TabDefault">
              <Group id="SharedTemplatesGroup">
                <Label resid="GroupLabel"/>
                <Control xsi:type="Button" id="OpenTemplatesPaneButton">
                  <Label resid="OpenPaneLabel"/>
                  <Supertip>
                    <Title resid="OpenPaneLabel"/>
                    <Description resid="OpenPaneDescription"/>
                  </Supertip>
                  <Icon>
                    <bt:Image size="16" resid="Icon.16"/>
                    <bt:Image size="32" resid="Icon.32"/>
                    <bt:Image size="80" resid="Icon.80"/>
                  </Icon>
                  <Action xsi:type="ShowTaskpane">
                    <SourceLocation resid="Taskpane.Url"/>
                  </Action>
                </Control>
              </Group>
            </OfficeTab>
          </ExtensionPoint>
          <ExtensionPoint xsi:type="MessageReadCommandSurface">
            <OfficeTab id="TabDefault">
              <Group id="SharedTemplatesReadGroup">
                <Label resid="GroupLabel"/>
                <Control xsi:type="Button" id="OpenTemplatesReadPaneButton">
                  <Label resid="BrowsePaneLabel"/>
                  <Supertip>
                    <Title resid="BrowsePaneLabel"/>
                    <Description resid="BrowsePaneDescription"/>
                  </Supertip>
                  <Icon>
                    <bt:Image size="16" resid="Icon.16"/>
                    <bt:Image size="32" resid="Icon.32"/>
                    <bt:Image size="80" resid="Icon.80"/>
                  </Icon>
                  <Action xsi:type="ShowTaskpane">
                    <SourceLocation resid="Taskpane.Url"/>
                  </Action>
                </Control>
              </Group>
            </OfficeTab>
          </ExtensionPoint>
        </DesktopFormFactor>
      </Host>
    </Hosts>
    <Resources>
      <bt:Images>
        <bt:Image id="Icon.16" DefaultValue="${xmlEscape(baseUrl)}/outlook-template-icon-16.png"/>
        <bt:Image id="Icon.32" DefaultValue="${xmlEscape(baseUrl)}/outlook-template-icon-32.png"/>
        <bt:Image id="Icon.80" DefaultValue="${xmlEscape(baseUrl)}/outlook-template-icon-80.png"/>
      </bt:Images>
      <bt:Urls>
        <bt:Url id="Commands.Url" DefaultValue="${xmlEscape(commandsUrl)}"/>
        <bt:Url id="Taskpane.Url" DefaultValue="${xmlEscape(taskpaneUrl)}"/>
      </bt:Urls>
      <bt:ShortStrings>
        <bt:String id="GroupLabel" DefaultValue="Shared Templates"/>
        <bt:String id="OpenPaneLabel" DefaultValue="Insert Template"/>
        <bt:String id="BrowsePaneLabel" DefaultValue="Browse Templates"/>
      </bt:ShortStrings>
      <bt:LongStrings>
        <bt:String id="OpenPaneDescription" DefaultValue="Open the shared company template library and insert content into this email."/>
        <bt:String id="BrowsePaneDescription" DefaultValue="Open the shared company template library. Start a new email to insert a template."/>
      </bt:LongStrings>
    </Resources>
    <VersionOverrides xmlns="http://schemas.microsoft.com/office/mailappversionoverrides/1.1" xsi:type="VersionOverridesV1_1">
      <Requirements>
        <bt:Sets DefaultMinVersion="1.5">
          <bt:Set Name="Mailbox"/>
        </bt:Sets>
      </Requirements>
      <Hosts>
        <Host xsi:type="MailHost">
          <DesktopFormFactor>
            <FunctionFile resid="Commands.Url"/>
            <ExtensionPoint xsi:type="MessageComposeCommandSurface">
              <OfficeTab id="TabDefault">
                <Group id="SharedTemplatesGroup">
                  <Label resid="GroupLabel"/>
                  <Control xsi:type="Button" id="OpenTemplatesPaneButton">
                    <Label resid="OpenPaneLabel"/>
                    <Supertip>
                      <Title resid="OpenPaneLabel"/>
                      <Description resid="OpenPaneDescription"/>
                    </Supertip>
                    <Icon>
                      <bt:Image size="16" resid="Icon.16"/>
                      <bt:Image size="32" resid="Icon.32"/>
                      <bt:Image size="80" resid="Icon.80"/>
                    </Icon>
                    <Action xsi:type="ShowTaskpane">
                      <SourceLocation resid="Taskpane.Url"/>
                      <SupportsPinning>true</SupportsPinning>
                    </Action>
                  </Control>
              </Group>
            </OfficeTab>
          </ExtensionPoint>
          <ExtensionPoint xsi:type="MessageReadCommandSurface">
            <OfficeTab id="TabDefault">
              <Group id="SharedTemplatesReadGroup">
                <Label resid="GroupLabel"/>
                <Control xsi:type="Button" id="OpenTemplatesReadPaneButton">
                  <Label resid="BrowsePaneLabel"/>
                  <Supertip>
                    <Title resid="BrowsePaneLabel"/>
                    <Description resid="BrowsePaneDescription"/>
                  </Supertip>
                  <Icon>
                    <bt:Image size="16" resid="Icon.16"/>
                    <bt:Image size="32" resid="Icon.32"/>
                    <bt:Image size="80" resid="Icon.80"/>
                  </Icon>
                  <Action xsi:type="ShowTaskpane">
                    <SourceLocation resid="Taskpane.Url"/>
                    <SupportsPinning>true</SupportsPinning>
                  </Action>
                </Control>
              </Group>
            </OfficeTab>
          </ExtensionPoint>
        </DesktopFormFactor>
      </Host>
    </Hosts>
      <Resources>
        <bt:Images>
          <bt:Image id="Icon.16" DefaultValue="${xmlEscape(baseUrl)}/outlook-template-icon-16.png"/>
          <bt:Image id="Icon.32" DefaultValue="${xmlEscape(baseUrl)}/outlook-template-icon-32.png"/>
          <bt:Image id="Icon.80" DefaultValue="${xmlEscape(baseUrl)}/outlook-template-icon-80.png"/>
        </bt:Images>
        <bt:Urls>
          <bt:Url id="Commands.Url" DefaultValue="${xmlEscape(commandsUrl)}"/>
          <bt:Url id="Taskpane.Url" DefaultValue="${xmlEscape(taskpaneUrl)}"/>
        </bt:Urls>
        <bt:ShortStrings>
          <bt:String id="GroupLabel" DefaultValue="Shared Templates"/>
          <bt:String id="OpenPaneLabel" DefaultValue="Insert Template"/>
          <bt:String id="BrowsePaneLabel" DefaultValue="Browse Templates"/>
        </bt:ShortStrings>
        <bt:LongStrings>
          <bt:String id="OpenPaneDescription" DefaultValue="Open the shared company template library and insert content into this email."/>
          <bt:String id="BrowsePaneDescription" DefaultValue="Open the shared company template library. Start a new email to insert a template."/>
        </bt:LongStrings>
      </Resources>
    </VersionOverrides>
  </VersionOverrides>
</OfficeApp>`

  return new NextResponse(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Content-Disposition": "attachment; filename=\"fratelli-cosulich-templates-manifest.xml\"",
      "Cache-Control": "no-store, max-age=0",
    },
  })
}
