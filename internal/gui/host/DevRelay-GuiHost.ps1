[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Url,
  [Parameter(Mandatory = $true)][string]$SdkRoot,
  [Parameter(Mandatory = $true)][string]$ProfileDir
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Xaml

$lib = Join-Path $SdkRoot "package\lib\net462"
$native = Join-Path $SdkRoot "package\runtimes\win-x64\native"
$coreDll = Join-Path $lib "Microsoft.Web.WebView2.Core.dll"
$wpfDll = Join-Path $lib "Microsoft.Web.WebView2.Wpf.dll"
if (-not ((Test-Path $coreDll) -and (Test-Path $wpfDll))) {
  throw "WebView2 SDK is not prepared."
}

$env:PATH = "$native;$env:PATH"
Add-Type -Path $coreDll
Add-Type -Path $wpfDll
New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null
[xml]$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        xmlns:shell="clr-namespace:System.Windows.Shell;assembly=PresentationFramework"
        xmlns:wv2="clr-namespace:Microsoft.Web.WebView2.Wpf;assembly=Microsoft.Web.WebView2.Wpf"
        Title="DevRelay" Width="780" Height="560" MinWidth="680" MinHeight="480"
        WindowStartupLocation="CenterScreen" WindowStyle="None" ResizeMode="CanResize"
        Background="#0B1020" Foreground="#F8FAFC" FontFamily="Segoe UI">
  <shell:WindowChrome.WindowChrome>
    <shell:WindowChrome CaptionHeight="36" ResizeBorderThickness="6"
                        GlassFrameThickness="0" CornerRadius="12"
                        UseAeroCaptionButtons="False" />
  </shell:WindowChrome.WindowChrome>
  <Window.Resources>
    <Style x:Key="ChromeButton" TargetType="Button">
      <Setter Property="Width" Value="40"/><Setter Property="Height" Value="36"/>
      <Setter Property="Padding" Value="0"/><Setter Property="Margin" Value="0"/>
      <Setter Property="BorderThickness" Value="0"/><Setter Property="Background" Value="Transparent"/>
      <Setter Property="Foreground" Value="#AEBBD0"/><Setter Property="Cursor" Value="Hand"/>
      <Setter Property="shell:WindowChrome.IsHitTestVisibleInChrome" Value="True"/>
      <Setter Property="Template">
        <Setter.Value><ControlTemplate TargetType="Button">
          <Border x:Name="B" Background="{TemplateBinding Background}">
            <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
          </Border>
          <ControlTemplate.Triggers>
            <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="B" Property="Background" Value="#222E46"/><Setter Property="Foreground" Value="#F8FAFC"/></Trigger>
            <Trigger Property="IsPressed" Value="True"><Setter TargetName="B" Property="Background" Value="#34415D"/></Trigger>
          </ControlTemplate.Triggers>
        </ControlTemplate></Setter.Value>
      </Setter>
    </Style>
    <Style x:Key="CloseButton" TargetType="Button" BasedOn="{StaticResource ChromeButton}">
      <Style.Triggers>
        <Trigger Property="IsMouseOver" Value="True"><Setter Property="Background" Value="#C42B1C"/><Setter Property="Foreground" Value="White"/></Trigger>
        <Trigger Property="IsPressed" Value="True"><Setter Property="Background" Value="#8E1B10"/></Trigger>
      </Style.Triggers>
    </Style>
    <Style x:Key="PowerButton" TargetType="Button">
      <Setter Property="Width" Value="76"/><Setter Property="Height" Value="26"/>
      <Setter Property="Margin" Value="0,5,6,5"/><Setter Property="Padding" Value="0"/>
      <Setter Property="BorderThickness" Value="0"/><Setter Property="Foreground" Value="#FFD9DD"/>
      <Setter Property="Background" Value="#491B25"/><Setter Property="FontSize" Value="11"/>
      <Setter Property="FontWeight" Value="Bold"/><Setter Property="Cursor" Value="Hand"/>
      <Setter Property="shell:WindowChrome.IsHitTestVisibleInChrome" Value="True"/>
      <Setter Property="Template"><Setter.Value><ControlTemplate TargetType="Button">
        <Border x:Name="P" Background="{TemplateBinding Background}" CornerRadius="13">
          <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
        </Border>
        <ControlTemplate.Triggers>
          <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="P" Property="Opacity" Value="0.88"/></Trigger>
          <Trigger Property="IsPressed" Value="True"><Setter TargetName="P" Property="Opacity" Value="0.70"/></Trigger>
        </ControlTemplate.Triggers>
      </ControlTemplate></Setter.Value></Setter>
    </Style>
  </Window.Resources>
  <Grid>
    <Grid.RowDefinitions><RowDefinition Height="36"/><RowDefinition Height="*"/></Grid.RowDefinitions>
    <Grid Grid.Row="0" Background="#0B1020">
      <Grid.ColumnDefinitions>
        <ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/><ColumnDefinition Width="40"/>
        <ColumnDefinition Width="40"/><ColumnDefinition Width="40"/><ColumnDefinition Width="40"/>
      </Grid.ColumnDefinitions>
      <TextBlock Margin="12,0,0,0" VerticalAlignment="Center" FontSize="13" FontWeight="SemiBold" Foreground="#AEBBD0" Text="DevRelay"/>
      <Button x:Name="PowerButton" Grid.Column="1" Style="{StaticResource PowerButton}" Content="START"/>
      <Button x:Name="SettingsButton" Grid.Column="2" Style="{StaticResource ChromeButton}" FontFamily="Segoe Fluent Icons" FontSize="15" Content="&#xE713;" ToolTip="Settings"/>
      <Button x:Name="MinButton" Grid.Column="3" Style="{StaticResource ChromeButton}" FontSize="16" Content="&#x2014;" ToolTip="Minimize"/>
      <Button x:Name="MaxButton" Grid.Column="4" Style="{StaticResource ChromeButton}" FontSize="12" Content="&#x25A1;" ToolTip="Maximize"/>
      <Button x:Name="CloseButton" Grid.Column="5" Style="{StaticResource CloseButton}" FontSize="17" Content="&#x00D7;" ToolTip="Close"/>
    </Grid>
    <wv2:WebView2 x:Name="WebView" Grid.Row="1" DefaultBackgroundColor="#0B1020"/>
  </Grid>
</Window>
'@

$reader = New-Object System.Xml.XmlNodeReader $xaml
$window = [Windows.Markup.XamlReader]::Load($reader)
$web = $window.FindName("WebView")
$powerButton = $window.FindName("PowerButton")
$settingsButton = $window.FindName("SettingsButton")
$minButton = $window.FindName("MinButton")
$maxButton = $window.FindName("MaxButton")
$closeButton = $window.FindName("CloseButton")
$brushConverter = New-Object Windows.Media.BrushConverter
function Brush([string]$Color) { return $brushConverter.ConvertFromString($Color) }

$origin = ([Uri]$Url).GetLeftPart([UriPartial]::Authority)
$script:lastState = $null
$script:busy = $false

$creation = New-Object Microsoft.Web.WebView2.Wpf.CoreWebView2CreationProperties
$creation.UserDataFolder = $ProfileDir
$web.CreationProperties = $creation

$web.add_CoreWebView2InitializationCompleted({
  param($sender, $eventArgs)
  if ($eventArgs.IsSuccess -and $null -ne $sender.CoreWebView2) {
    Write-Host "[GuiHost] WebView2 initialized."
    $sender.CoreWebView2.Settings.AreDefaultContextMenusEnabled = $false
    $sender.CoreWebView2.Settings.AreDevToolsEnabled = $false
    $sender.CoreWebView2.Settings.IsStatusBarEnabled = $false
    $sender.CoreWebView2.Settings.AreBrowserAcceleratorKeysEnabled = $false
    $sender.CoreWebView2.Navigate($Url)
  } else {
    Write-Host "[GuiHost] WebView2 init failed: $($eventArgs.InitializationException)"
  }
})
$window.Add_Loaded({
  try { [void]$web.EnsureCoreWebView2Async() }
  catch { Write-Host "[GuiHost] EnsureCoreWebView2Async failed: $($_.Exception.Message)" }
})

function Refresh-State {
  try {
    $state = Invoke-RestMethod -Uri "$origin/api/state" -Method Get -TimeoutSec 1
    $script:lastState = $state
    $active = [bool]($state.running -or $state.starting)
    if ($active) {
      $powerButton.Content = "STOP"
      $powerButton.Background = Brush "#FF6F7D"
      $powerButton.Foreground = Brush "#240006"
    } else {
      $powerButton.Content = "START"
      $powerButton.Background = Brush "#491B25"
      $powerButton.Foreground = Brush "#FFD9DD"
    }
    $powerButton.IsEnabled = -not [bool]$state.stopping -and -not $script:busy
  } catch {
    $powerButton.IsEnabled = $false
  }
}
$powerButton.Add_Click({
  if ($script:busy -or $null -eq $script:lastState) { return }
  $script:busy = $true
  try {
    $active = [bool]($script:lastState.running -or $script:lastState.starting)
    $endpoint = if ($active) { "stop" } else { "start" }
    Invoke-RestMethod -Uri "$origin/api/$endpoint" -Method Post -Headers @{ Origin = $origin } -ContentType "application/json" -Body "{}" -TimeoutSec 4 | Out-Null
  } catch {
  } finally {
    $script:busy = $false
    Refresh-State
  }
})

$settingsButton.Add_Click({
  try {
    [void]$web.ExecuteScriptAsync("window.DevRelayUi && window.DevRelayUi.toggleSettings && window.DevRelayUi.toggleSettings();")
  } catch {}
})
$minButton.Add_Click({ $window.WindowState = [Windows.WindowState]::Minimized })
$maxButton.Add_Click({
  if ($window.WindowState -eq [Windows.WindowState]::Maximized) {
    $window.WindowState = [Windows.WindowState]::Normal
  } else {
    $window.WindowState = [Windows.WindowState]::Maximized
  }
})
$closeButton.Add_Click({ $window.Close() })

$timer = New-Object Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(500)
$timer.Add_Tick({ Refresh-State })
$window.Add_ContentRendered({ Refresh-State; $timer.Start() })
$window.Add_Closed({ $timer.Stop() })

[void]$window.ShowDialog()
