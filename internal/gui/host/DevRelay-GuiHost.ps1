[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Url,
  [Parameter(Mandatory = $true)][string]$SdkRoot,
  [Parameter(Mandatory = $true)][string]$ProfileDir,
  [Parameter(Mandatory = $true)][string]$WindowStatePath,
  [string]$Title = "DevRelay",
  [switch]$SetupMode,
  [ValidateRange(480, 2000)][double]$InitialWidth = 780,
  [ValidateRange(480, 1600)][double]$InitialHeight = 560,
  [ValidateRange(400, 1200)][double]$MinimumWidth = 480,
  [ValidateRange(360, 1200)][double]$MinimumHeight = 480,
  [string]$CascadeFromStatePath = "",
  [ValidateRange(0, 200)][double]$CascadeOffset = 40
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Xaml
Add-Type -AssemblyName System.Drawing

$lib = Join-Path $SdkRoot "package\lib\net462"
$native = Join-Path $SdkRoot "package\runtimes\win-x64\native"
$coreDll = Join-Path $lib "Microsoft.Web.WebView2.Core.dll"
$wpfDll = Join-Path $lib "Microsoft.Web.WebView2.Wpf.dll"
if (-not ((Test-Path $coreDll) -and (Test-Path $wpfDll))) { throw "WebView2 SDK is not prepared." }
$env:PATH = "$native;$env:PATH"
Add-Type -Path $coreDll
Add-Type -Path $wpfDll
New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null

[xml]$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        xmlns:shell="clr-namespace:System.Windows.Shell;assembly=PresentationFramework"
        xmlns:wv2="clr-namespace:Microsoft.Web.WebView2.Wpf;assembly=Microsoft.Web.WebView2.Wpf"
        Title="DevRelay" Width="780" Height="560" MinWidth="480" MinHeight="480"
        WindowStartupLocation="Manual" WindowStyle="None" ResizeMode="CanResize"
        Background="{DynamicResource WindowBackgroundBrush}" Foreground="{DynamicResource TextPrimaryBrush}"
        FontFamily="Noto Sans Mono" UseLayoutRounding="True" SnapsToDevicePixels="True">
  <shell:WindowChrome.WindowChrome>
    <shell:WindowChrome CaptionHeight="36" ResizeBorderThickness="6" GlassFrameThickness="0"
                        CornerRadius="12" UseAeroCaptionButtons="False" />
  </shell:WindowChrome.WindowChrome>
  <Window.Resources>
    <SolidColorBrush x:Key="WindowBackgroundBrush" Color="#FFFFFF" />
    <SolidColorBrush x:Key="TextPrimaryBrush" Color="#2B2B2B" />
    <SolidColorBrush x:Key="TextSecondaryBrush" Color="#707070" />
    <SolidColorBrush x:Key="BorderBrush" Color="#D4D4D4" />
    <SolidColorBrush x:Key="SurfaceHoverBrush" Color="#F2F2F2" />
    <SolidColorBrush x:Key="SurfacePressedBrush" Color="#E5E5E5" />
    <SolidColorBrush x:Key="WindowCloseBrush" Color="#C42B1C" />
    <SolidColorBrush x:Key="WindowClosePressedBrush" Color="#8E1B10" />

    <Style x:Key="WindowChromeGlyphStyle" TargetType="TextBlock">      <Setter Property="FontFamily" Value="Segoe Fluent Icons" />
      <Setter Property="FontSize" Value="10" />
      <Setter Property="FontWeight" Value="Normal" />
      <Setter Property="HorizontalAlignment" Value="Center" />
      <Setter Property="VerticalAlignment" Value="Center" />
      <Setter Property="TextAlignment" Value="Center" />
      <Setter Property="UseLayoutRounding" Value="True" />
      <Setter Property="SnapsToDevicePixels" Value="True" />
      <Setter Property="TextOptions.TextFormattingMode" Value="Display" />
      <Setter Property="TextOptions.TextHintingMode" Value="Fixed" />
      <Setter Property="TextOptions.TextRenderingMode" Value="Grayscale" />
    </Style>

    <Style x:Key="TitleBarActionButtonStyle" TargetType="Button">
      <Setter Property="Width" Value="40"/><Setter Property="Height" Value="36"/>
      <Setter Property="Padding" Value="0"/><Setter Property="Margin" Value="0"/>
      <Setter Property="Foreground" Value="{DynamicResource TextSecondaryBrush}" />
      <Setter Property="Background" Value="Transparent"/><Setter Property="BorderThickness" Value="0"/>
      <Setter Property="Cursor" Value="Hand"/><Setter Property="VerticalAlignment" Value="Center"/>
      <Setter Property="UseLayoutRounding" Value="True"/><Setter Property="SnapsToDevicePixels" Value="True"/>
      <Setter Property="shell:WindowChrome.IsHitTestVisibleInChrome" Value="True"/>
      <Setter Property="Template"><Setter.Value><ControlTemplate TargetType="Button">
        <Border x:Name="Chrome" Background="{TemplateBinding Background}" CornerRadius="0">
          <TextBlock Style="{StaticResource WindowChromeGlyphStyle}" FontSize="15"
                     Foreground="{TemplateBinding Foreground}" Text="{TemplateBinding Content}" />
        </Border>        <ControlTemplate.Triggers>
          <Trigger Property="IsMouseOver" Value="True">
            <Setter TargetName="Chrome" Property="Background" Value="{DynamicResource SurfaceHoverBrush}" />
            <Setter Property="Foreground" Value="{DynamicResource TextPrimaryBrush}" />
          </Trigger>
          <Trigger Property="IsPressed" Value="True">
            <Setter TargetName="Chrome" Property="Background" Value="{DynamicResource SurfacePressedBrush}" />
          </Trigger>
        </ControlTemplate.Triggers>
      </ControlTemplate></Setter.Value></Setter>
    </Style>

    <Style x:Key="WindowSystemButtonStyle" TargetType="Button">
      <Setter Property="Width" Value="40"/><Setter Property="Height" Value="36"/>
      <Setter Property="Padding" Value="0"/><Setter Property="Margin" Value="0"/>
      <Setter Property="Foreground" Value="{DynamicResource TextSecondaryBrush}" />
      <Setter Property="Background" Value="Transparent"/><Setter Property="BorderThickness" Value="0"/>
      <Setter Property="Cursor" Value="Hand"/><Setter Property="VerticalAlignment" Value="Center"/>
      <Setter Property="UseLayoutRounding" Value="True"/><Setter Property="SnapsToDevicePixels" Value="True"/>
      <Setter Property="shell:WindowChrome.IsHitTestVisibleInChrome" Value="True"/>
      <Setter Property="Template"><Setter.Value><ControlTemplate TargetType="Button">
        <Border Background="{TemplateBinding Background}" CornerRadius="0" UseLayoutRounding="True" SnapsToDevicePixels="True">
          <TextBlock Style="{StaticResource WindowChromeGlyphStyle}" Foreground="{TemplateBinding Foreground}" Text="{TemplateBinding Content}" />
        </Border>
      </ControlTemplate></Setter.Value></Setter>
      <Style.Triggers>
        <Trigger Property="IsMouseOver" Value="True"><Setter Property="Background" Value="{DynamicResource SurfaceHoverBrush}"/><Setter Property="Foreground" Value="{DynamicResource TextPrimaryBrush}"/></Trigger>
        <Trigger Property="IsPressed" Value="True"><Setter Property="Background" Value="{DynamicResource SurfacePressedBrush}"/></Trigger>
      </Style.Triggers>
    </Style>

    <Style x:Key="WindowCloseButtonStyle" TargetType="Button" BasedOn="{StaticResource WindowSystemButtonStyle}">
      <Style.Triggers>
        <Trigger Property="IsMouseOver" Value="True">
          <Setter Property="Background" Value="{DynamicResource WindowCloseBrush}" />
          <Setter Property="Foreground" Value="White" />
        </Trigger>
        <Trigger Property="IsPressed" Value="True">
          <Setter Property="Background" Value="{DynamicResource WindowClosePressedBrush}" />
          <Setter Property="Foreground" Value="White" />
        </Trigger>
      </Style.Triggers>
    </Style>

    <Style x:Key="PowerButtonStyle" TargetType="Button">      <Setter Property="Width" Value="76"/><Setter Property="Height" Value="26"/>
      <Setter Property="Margin" Value="0,5,6,5"/><Setter Property="Padding" Value="0"/>
      <Setter Property="BorderThickness" Value="0"/><Setter Property="Foreground" Value="White"/>
      <Setter Property="Background" Value="#B42318"/><Setter Property="FontSize" Value="11"/>
      <Setter Property="FontWeight" Value="Bold"/><Setter Property="Cursor" Value="Hand"/>
      <Setter Property="shell:WindowChrome.IsHitTestVisibleInChrome" Value="True"/>
      <Setter Property="Template"><Setter.Value><ControlTemplate TargetType="Button">
        <Border x:Name="P" Background="{TemplateBinding Background}" CornerRadius="13">
          <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
        </Border>
        <ControlTemplate.Triggers>
          <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="P" Property="Opacity" Value="0.88"/></Trigger>
          <Trigger Property="IsPressed" Value="True"><Setter TargetName="P" Property="Opacity" Value="0.72"/></Trigger>
        </ControlTemplate.Triggers>
      </ControlTemplate></Setter.Value></Setter>
    </Style>
  </Window.Resources>

  <Grid>
    <Grid.RowDefinitions><RowDefinition Height="36"/><RowDefinition Height="*"/></Grid.RowDefinitions>
    <Grid x:Name="TitleBar" Grid.Row="0" Background="{DynamicResource WindowBackgroundBrush}">
      <Grid.ColumnDefinitions>
        <ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/><ColumnDefinition Width="40"/>
        <ColumnDefinition Width="40"/><ColumnDefinition Width="40"/><ColumnDefinition Width="40"/>
      </Grid.ColumnDefinitions>      <TextBlock x:Name="TitleText" Margin="12,0,0,0" VerticalAlignment="Center" FontSize="13"
                 FontWeight="SemiBold" Foreground="{DynamicResource TextSecondaryBrush}" Text="DevRelay"/>
      <Button x:Name="PowerButton" Grid.Column="1" Style="{StaticResource PowerButtonStyle}" Content="START"/>
      <Button x:Name="SettingsButton" Grid.Column="2" Style="{StaticResource TitleBarActionButtonStyle}"
              Content="&#xE713;" ToolTip="Settings"/>
      <Button x:Name="MinButton" Grid.Column="3" Style="{StaticResource WindowSystemButtonStyle}"
              Content="&#xE921;" ToolTip="Minimize"/>
      <Button x:Name="MaxButton" Grid.Column="4" Style="{StaticResource WindowSystemButtonStyle}"
              Content="&#xE922;" ToolTip="Maximize / Restore"/>
      <Button x:Name="CloseButton" Grid.Column="5" Style="{StaticResource WindowCloseButtonStyle}"
              Content="&#xE8BB;" ToolTip="Close"/>
    </Grid>
    <wv2:WebView2 x:Name="WebView" Grid.Row="1" Margin="6,0,6,6" DefaultBackgroundColor="White" />
  </Grid>
</Window>
'@

$reader = New-Object System.Xml.XmlNodeReader $xaml
$window = [Windows.Markup.XamlReader]::Load($reader)
$window.Title = $Title
$window.Width = $InitialWidth
$window.Height = $InitialHeight
$window.MinWidth = $MinimumWidth
$window.MinHeight = $MinimumHeight

function Test-WindowDimension([double]$Value, [double]$Minimum) {
  return -not [double]::IsNaN($Value) -and -not [double]::IsInfinity($Value) -and $Value -ge $Minimum -and $Value -le 10000
}

function Test-WindowCoordinate([double]$Value) {
  return -not [double]::IsNaN($Value) -and -not [double]::IsInfinity($Value) -and $Value -ge -32000 -and $Value -le 32000
}

$savedLeft = $null
$savedTop = $null
try {
  if (Test-Path -LiteralPath $WindowStatePath) {
    $savedWindow = Get-Content -LiteralPath $WindowStatePath -Raw | ConvertFrom-Json
    $savedWidth = [double]$savedWindow.width
    $savedHeight = [double]$savedWindow.height
    if (Test-WindowDimension $savedWidth $window.MinWidth) { $window.Width = $savedWidth }
    if (Test-WindowDimension $savedHeight $window.MinHeight) { $window.Height = $savedHeight }
    if ($savedWindow.PSObject.Properties.Name -contains "left") {
      if (Test-WindowCoordinate ([double]$savedWindow.left)) { $savedLeft = [double]$savedWindow.left }
    }
    if ($savedWindow.PSObject.Properties.Name -contains "top") {
      if (Test-WindowCoordinate ([double]$savedWindow.top)) { $savedTop = [double]$savedWindow.top }
    }
  }
} catch {
  Write-Host "[GuiHost] Window state restore failed: $($_.Exception.Message)"
}

$work = [Windows.SystemParameters]::WorkArea
$window.Left = if ($null -ne $savedLeft) { $savedLeft } else { $work.Left + [Math]::Max(0, ($work.Width - $window.Width) / 2) }
$window.Top = if ($null -ne $savedTop) { $savedTop } else { $work.Top + [Math]::Max(0, ($work.Height - $window.Height) / 2) }
$virtualLeft = [Windows.SystemParameters]::VirtualScreenLeft
$virtualTop = [Windows.SystemParameters]::VirtualScreenTop
$virtualRight = $virtualLeft + [Windows.SystemParameters]::VirtualScreenWidth
$virtualBottom = $virtualTop + [Windows.SystemParameters]::VirtualScreenHeight
$window.Left = [Math]::Min([Math]::Max($window.Left, $virtualLeft), [Math]::Max($virtualLeft, $virtualRight - $window.Width))
$window.Top = [Math]::Min([Math]::Max($window.Top, $virtualTop), [Math]::Max($virtualTop, $virtualBottom - $window.Height))
try {
  if ($CascadeFromStatePath -and (Test-Path -LiteralPath $CascadeFromStatePath)) {
    $anchor = Get-Content -LiteralPath $CascadeFromStatePath -Raw | ConvertFrom-Json
    $hasLeft = $anchor.PSObject.Properties.Name -contains "left"
    $hasTop = $anchor.PSObject.Properties.Name -contains "top"
    if ($hasLeft -and $hasTop) {
      $anchorLeft = [double]$anchor.left
      $anchorTop = [double]$anchor.top
    } else {
      $anchorLeft = [double]::NaN
      $anchorTop = [double]::NaN
    }
    if ((Test-WindowCoordinate $anchorLeft) -and (Test-WindowCoordinate $anchorTop)) {
      $candidateLeft = $anchorLeft + $CascadeOffset
      $candidateTop = $anchorTop + $CascadeOffset
      $window.Left = [Math]::Min([Math]::Max($candidateLeft, $virtualLeft), [Math]::Max($virtualLeft, $virtualRight - $window.Width))
      $window.Top = [Math]::Min([Math]::Max($candidateTop, $virtualTop), [Math]::Max($virtualTop, $virtualBottom - $window.Height))
    }
  }
} catch {
  Write-Host "[GuiHost] Window cascade positioning failed: $($_.Exception.Message)"
}
$window.ShowActivated = $true
$iconPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..\assets\devrelay-icon.png"))
if (Test-Path -LiteralPath $iconPath) {
  try {
    $icon = New-Object Windows.Media.Imaging.BitmapImage
    $icon.BeginInit()
    $icon.CacheOption = [Windows.Media.Imaging.BitmapCacheOption]::OnLoad
    $icon.UriSource = [Uri]::new($iconPath, [UriKind]::Absolute)
    $icon.EndInit()
    $icon.Freeze()
    $window.Icon = $icon
  } catch { Write-Host "[GuiHost] Window icon load failed: $($_.Exception.Message)" }
}
$web = $window.FindName("WebView")
$titleBar = $window.FindName("TitleBar")
$titleText = $window.FindName("TitleText")
$powerButton = $window.FindName("PowerButton")
$settingsButton = $window.FindName("SettingsButton")
$minButton = $window.FindName("MinButton")
$maxButton = $window.FindName("MaxButton")
$closeButton = $window.FindName("CloseButton")
$titleText.Text = $Title
if ($SetupMode) {
  $powerButton.Visibility = [Windows.Visibility]::Collapsed
  $settingsButton.Visibility = [Windows.Visibility]::Collapsed
  $titleBar.ColumnDefinitions[2].Width = New-Object Windows.GridLength(0)
}
$brushConverter = New-Object Windows.Media.BrushConverter
function Brush([string]$Color) { return $brushConverter.ConvertFromString($Color) }
function Resource-Brush([string]$Name, [string]$Color) { $window.Resources[$Name] = Brush $Color }$origin = ([Uri]$Url).GetLeftPart([UriPartial]::Authority)
$script:lastState = $null
$script:busy = $false
$script:theme = ""
$script:setupRuntimeVisible = $false

function Show-DevRelayWindowForeground {
  try {
    if ($window.WindowState -eq [Windows.WindowState]::Minimized) {
      [System.Windows.SystemCommands]::RestoreWindow($window)
    }
    $window.Topmost = $true
    [void]$window.Activate()
    [void]$window.Focus()
    $window.Topmost = $false
  } catch {}
}

function Apply-Theme([string]$Theme) {
  if ($Theme -eq $script:theme) { return }
  $script:theme = $Theme
  if ($Theme -eq "black-soft") {
    Resource-Brush "WindowBackgroundBrush" "#000000"
    Resource-Brush "TextPrimaryBrush" "#D6D6D6"
    Resource-Brush "TextSecondaryBrush" "#8A8A8A"
    Resource-Brush "BorderBrush" "#3A3A3A"
    Resource-Brush "SurfaceHoverBrush" "#181818"
    Resource-Brush "SurfacePressedBrush" "#282828"
    $web.DefaultBackgroundColor = [System.Drawing.Color]::Black
  } else {
    Resource-Brush "WindowBackgroundBrush" "#FFFFFF"
    Resource-Brush "TextPrimaryBrush" "#2B2B2B"
    Resource-Brush "TextSecondaryBrush" "#707070"
    Resource-Brush "BorderBrush" "#D4D4D4"
    Resource-Brush "SurfaceHoverBrush" "#F2F2F2"
    Resource-Brush "SurfacePressedBrush" "#E5E5E5"
    $web.DefaultBackgroundColor = [System.Drawing.Color]::White
  }
}

$creation = New-Object Microsoft.Web.WebView2.Wpf.CoreWebView2CreationProperties
$creation.UserDataFolder = $ProfileDir
$web.CreationProperties = $creation
$web.add_CoreWebView2InitializationCompleted({
  param($sender, $eventArgs)
  if ($eventArgs.IsSuccess -and $null -ne $sender.CoreWebView2) {
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
    Apply-Theme ([string]$state.theme)
    if ($SetupMode) {
      $hasRegistrationRuntime = ($state.PSObject.Properties.Name -contains "registrationRuntime") -and ($null -ne $state.registrationRuntime)
      if ($hasRegistrationRuntime -and -not $script:setupRuntimeVisible) { Show-DevRelayWindowForeground }
      $script:setupRuntimeVisible = $hasRegistrationRuntime
    }
    $active = [bool]($state.running -or $state.starting)
    $powerButton.Content = if ($active) { "STOP" } else { "START" }
    $powerButton.Background = Brush $(if ($active) { "#D92D20" } else { "#B42318" })
    $powerButton.Foreground = Brush "#FFFFFF"
    $canStartOrStop = $active -or [bool]$state.setupComplete
    $powerButton.IsEnabled = $canStartOrStop -and -not [bool]$state.stopping -and -not $script:busy
  } catch { $powerButton.IsEnabled = $false }
}
$powerButton.Add_Click({
  if ($script:busy -or $null -eq $script:lastState) { return }
  $script:busy = $true
  try {
    $active = [bool]($script:lastState.running -or $script:lastState.starting)
    $endpoint = if ($active) { "stop" } else { "start" }
    Invoke-RestMethod -Uri "$origin/api/$endpoint" -Method Post -Headers @{ Origin = $origin } `
      -ContentType "application/json" -Body "{}" -TimeoutSec 4 | Out-Null
  } catch {
  } finally {
    $script:busy = $false
    Refresh-State
  }
})

$settingsButton.Add_Click({
  try { [void]$web.ExecuteScriptAsync("window.DevRelayUi && window.DevRelayUi.toggleSettings && window.DevRelayUi.toggleSettings();") }
  catch {}
})
$minButton.Add_Click({ [System.Windows.SystemCommands]::MinimizeWindow($window) })
$maxButton.Add_Click({
  if ($window.WindowState -eq [Windows.WindowState]::Maximized) {
    [System.Windows.SystemCommands]::RestoreWindow($window)
  } else {
    [System.Windows.SystemCommands]::MaximizeWindow($window)
  }
})
$closeButton.Add_Click({ [System.Windows.SystemCommands]::CloseWindow($window) })
$window.Add_StateChanged({
  $maxButton.Content = if ($window.WindowState -eq [Windows.WindowState]::Maximized) { [char]0xE923 } else { [char]0xE922 }
})

$windowSizeTimer = New-Object Windows.Threading.DispatcherTimer
$windowSizeTimer.Interval = [TimeSpan]::FromMilliseconds(250)
$script:lastNormalWidth = [double]$window.Width
$script:lastNormalHeight = [double]$window.Height
$script:lastNormalLeft = [double]$window.Left
$script:lastNormalTop = [double]$window.Top

function Save-WindowSize {
  try {
    $width = $script:lastNormalWidth
    $height = $script:lastNormalHeight
    $left = $script:lastNormalLeft
    $top = $script:lastNormalTop
    if ($window.WindowState -eq [Windows.WindowState]::Normal) {
      $width = [double]$window.ActualWidth
      $height = [double]$window.ActualHeight
      $left = [double]$window.Left
      $top = [double]$window.Top
    } elseif (-not $window.RestoreBounds.IsEmpty) {
      $width = [double]$window.RestoreBounds.Width
      $height = [double]$window.RestoreBounds.Height
      $left = [double]$window.RestoreBounds.Left
      $top = [double]$window.RestoreBounds.Top
    }
    if (-not (Test-WindowDimension $width $window.MinWidth) -or -not (Test-WindowDimension $height $window.MinHeight)) { return }
    $script:lastNormalWidth = $width
    $script:lastNormalHeight = $height
    if (-not (Test-WindowCoordinate $left) -or -not (Test-WindowCoordinate $top)) { return }
    $script:lastNormalLeft = $left
    $script:lastNormalTop = $top
    $parent = Split-Path -Parent $WindowStatePath
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    $json = @{ width = [Math]::Round($width, 1); height = [Math]::Round($height, 1); left = [Math]::Round($left, 1); top = [Math]::Round($top, 1) } | ConvertTo-Json
    [IO.File]::WriteAllText($WindowStatePath, $json + [Environment]::NewLine, [Text.Encoding]::UTF8)
  } catch {
    Write-Host "[GuiHost] Window size save failed: $($_.Exception.Message)"
  }
}
$windowSizeTimer.Add_Tick({ $windowSizeTimer.Stop(); Save-WindowSize })
$window.Add_SizeChanged({
  if ($window.WindowState -eq [Windows.WindowState]::Normal) {
    $script:lastNormalWidth = [double]$window.ActualWidth
    $script:lastNormalHeight = [double]$window.ActualHeight
    $windowSizeTimer.Stop()
    $windowSizeTimer.Start()
  }
})
$window.Add_LocationChanged({
  if ($window.WindowState -eq [Windows.WindowState]::Normal) {
    $script:lastNormalLeft = [double]$window.Left
    $script:lastNormalTop = [double]$window.Top
    $windowSizeTimer.Stop()
    $windowSizeTimer.Start()
  }
})
$window.Add_Closing({ $windowSizeTimer.Stop(); Save-WindowSize })

$timer = New-Object Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(500)
$timer.Add_Tick({ Refresh-State })
$window.Add_ContentRendered({
  Show-DevRelayWindowForeground
  Save-WindowSize
  Refresh-State
  $timer.Start()
})
$window.Add_Closed({ $timer.Stop(); $windowSizeTimer.Stop() })

[void]$window.ShowDialog()
