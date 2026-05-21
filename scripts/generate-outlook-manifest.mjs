import fs from "node:fs/promises"
import path from "node:path"

const baseUrl = (process.env.MANIFEST_BASE_URL || "https://localhost:3002").replace(/\/$/, "")
const manifestPath = path.join(process.cwd(), "downloads", "fratelli-cosulich-templates-manifest.xml")

const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<OfficeApp xmlns="http://schemas.microsoft.com/office/appforoffice/1.1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:bt="http://schemas.microsoft.com/office/officeappbasictypes/1.0"
  xsi:type="MailApp">
  <Id>6f6b5bde-1a6b-4c82-8300-1d2d728c7c61</Id>
  <Version>1.0.0.0</Version>
  <ProviderName>Fratelli Cosulich</ProviderName>
  <DefaultLocale>en-US</DefaultLocale>
  <DisplayName DefaultValue="Fratelli Cosulich Templates"/>
  <Description DefaultValue="Insert shared company email templates from the central template library."/>
  <IconUrl DefaultValue="${baseUrl}/logo.png"/>
  <HighResolutionIconUrl DefaultValue="${baseUrl}/logo.png"/>
  <SupportUrl DefaultValue="${baseUrl}/admin/emailtemplates"/>
  <AppDomains>
    <AppDomain>${baseUrl}</AppDomain>
  </AppDomains>
  <Hosts>
    <Host Name="Mailbox"/>
  </Hosts>
  <Requirements>
    <Sets>
      <Set Name="Mailbox" MinVersion="1.5"/>
    </Sets>
  </Requirements>
  <FormSettings>
    <Form xsi:type="ItemEdit">
      <DesktopSettings>
        <SourceLocation DefaultValue="${baseUrl}/outlook-addin/taskpane"/>
        <RequestedHeight>250</RequestedHeight>
      </DesktopSettings>
    </Form>
  </FormSettings>
  <Permissions>ReadWriteItem</Permissions>
  <Rule xsi:type="RuleCollection" Mode="Or">
    <Rule xsi:type="ItemIs" ItemType="Message" FormType="Edit"/>
  </Rule>
  <DisableEntityHighlighting>false</DisableEntityHighlighting>
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
        </DesktopFormFactor>
      </Host>
    </Hosts>
    <Resources>
      <bt:Images>
        <bt:Image id="Icon.16" DefaultValue="${baseUrl}/logo.png"/>
        <bt:Image id="Icon.32" DefaultValue="${baseUrl}/logo.png"/>
        <bt:Image id="Icon.80" DefaultValue="${baseUrl}/logo.png"/>
      </bt:Images>
      <bt:Urls>
        <bt:Url id="Commands.Url" DefaultValue="${baseUrl}/outlook-addin/commands"/>
        <bt:Url id="Taskpane.Url" DefaultValue="${baseUrl}/outlook-addin/taskpane"/>
      </bt:Urls>
      <bt:ShortStrings>
        <bt:String id="GroupLabel" DefaultValue="Shared Templates"/>
        <bt:String id="OpenPaneLabel" DefaultValue="Insert Template"/>
      </bt:ShortStrings>
      <bt:LongStrings>
        <bt:String id="OpenPaneDescription" DefaultValue="Open the shared company template library and insert content into this email."/>
      </bt:LongStrings>
    </Resources>
  </VersionOverrides>
</OfficeApp>`

await fs.mkdir(path.dirname(manifestPath), { recursive: true })
await fs.writeFile(manifestPath, xml, "utf8")
console.log(manifestPath)
