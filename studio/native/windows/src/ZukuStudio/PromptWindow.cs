using System;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Threading;
using Zuku.Studio.Core;

namespace Zuku.Studio;

/// <summary>
/// Native approval for browser pairing and masked provider credentials. Plain WPF text only (no
/// HTML, no markup parsing). Refusal is the default and cancel button; the window closes itself
/// with a refusal at the host's deadline. The renderer never sees these decisions or values.
/// </summary>
sealed class PromptWindow : Window
{
    static readonly Brush Ember = new SolidColorBrush(Color.FromRgb(0xFF, 0x87, 0x00));   // ANSI 208, as the CLI's (exp!)
    readonly PromptRequest prompt;
    readonly Action<PromptRequest, bool, string> answer;
    readonly DispatcherTimer timer;
    readonly TextBlock countdown = new() { Margin = new Thickness(0, 12, 0, 0), Foreground = Brushes.DimGray };
    readonly PasswordBox? secret;
    bool answered, closing;

    public string RequestId => prompt.RequestId;

    public PromptWindow(Window owner, PromptRequest prompt, Action<PromptRequest, bool, string> answer)
    {
        this.prompt = prompt;
        this.answer = answer;
        Owner = owner;
        Title = prompt.Kind == PromptKind.Pairing ? "ZUKU 웹 연결 승인" : "제공자 인증";
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        ResizeMode = ResizeMode.NoResize;
        SizeToContent = SizeToContent.WidthAndHeight;
        ShowInTaskbar = false;
        MaxWidth = 560;

        var body = new StackPanel { Margin = new Thickness(24) };
        if (prompt.Kind == PromptKind.Pairing)
        {
            // Fixed text: the only variable input (origin) was required to equal the official origin.
            body.Children.Add(Text("https://ai.zuzunza.com 웹 화면을 이 컴퓨터의 ZUKU Studio와 연결하시겠습니까?", bold: true));
            body.Children.Add(Text("허용하면 이 브라우저가 Studio에서 선택한 게임 프로젝트와 등록된 제공자로 작업할 수 있습니다. 직접 요청하지 않았다면 거절하세요."));
        }
        else
        {
            var provider = new TextBlock { TextWrapping = TextWrapping.Wrap, FontWeight = FontWeights.SemiBold };
            provider.Inlines.Add(new Run("제공자: " + prompt.ProviderId));
            if (prompt.Experimental)
            {
                // Only the metadata flag decides this; never the provider or model name.
                provider.Inlines.Add(new Run(" "));
                provider.Inlines.Add(new Run("(exp!)") { Foreground = Ember });
            }
            body.Children.Add(provider);
            body.Children.Add(Text(prompt.Question ?? ""));
            secret = new PasswordBox { MaxLength = Limits.SecretValueChars, Margin = new Thickness(0, 12, 0, 0), MinWidth = 360 };
            body.Children.Add(secret);
            body.Children.Add(Text("입력값은 이 컴퓨터의 ZUKU 코어에만 전달되며 화면이나 웹 페이지에 표시되지 않습니다."));
        }
        body.Children.Add(countdown);

        var refuse = new Button { Content = "거절", IsDefault = true, IsCancel = true, MinWidth = 96, Margin = new Thickness(0, 0, 8, 0) };
        var accept = new Button { Content = prompt.Kind == PromptKind.Pairing ? "연결 허용" : "확인", MinWidth = 96 };
        refuse.Click += (_, _) => Finish(false);
        accept.Click += (_, _) => Finish(true);
        var buttons = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 20, 0, 0) };
        buttons.Children.Add(refuse);
        buttons.Children.Add(accept);
        body.Children.Add(buttons);
        Content = body;

        timer = new DispatcherTimer(DispatcherPriority.Normal, Dispatcher) { Interval = TimeSpan.FromSeconds(1) };
        timer.Tick += (_, _) => UpdateDeadline();
        Loaded += (_, _) => { UpdateDeadline(); timer.Start(); (secret as UIElement ?? refuse).Focus(); Keyboard.Focus(secret as IInputElement ?? refuse); };
        Closing += (_, _) => closing = true;
        Closed += (_, _) => { timer.Stop(); Finish(false); };
    }

    static TextBlock Text(string value, bool bold = false) => new()
    {
        Text = value,
        TextWrapping = TextWrapping.Wrap,
        Margin = new Thickness(0, 8, 0, 0),
        FontWeight = bold ? FontWeights.SemiBold : FontWeights.Normal,
    };

    void UpdateDeadline()
    {
        var remaining = prompt.ExpiresAt - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (remaining <= 0) { Finish(false); return; }
        countdown.Text = $"{(remaining + 999) / 1000}초 후 자동으로 거절됩니다.";
    }

    void Finish(bool allow)
    {
        if (answered) return;
        answered = true;
        timer.Stop();
        var value = allow && secret is not null ? secret.Password : "";
        secret?.Clear();
        answer(prompt, allow, value);
        if (!closing) Close();
    }

    /// <summary>The host closed or superseded the request: close without sending a decision.</summary>
    public void Dismiss()
    {
        answered = true;
        timer.Stop();
        secret?.Clear();
        if (!closing) Close();
    }
}
